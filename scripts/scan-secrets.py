#!/usr/bin/env python3
"""Credential-leak gate for this repository and for the shipped pack ZIP.

Why this exists
---------------
Two router keys were committed to this public repo in June 2026 (audit docs and
a test script) and sat in `main` for three months. Nothing failed: tests were
green, the build was green, and no tool ever looked at the strings inside the
docs. A leak that no gate can see is a leak that ships.

This gate answers one question mechanically: does anything that gets PUBLISHED
carry a credential-shaped string? It is deliberately narrow — named patterns
only, no Shannon-entropy scoring. Entropy scoring is noisy on minified JS and
trains everyone to ignore the output; a gate nobody trusts is worse than none.

Usage
-----
    python3 scripts/scan-secrets.py --tracked          # what CI runs (git index)
    python3 scripts/scan-secrets.py <path> [...]       # files, dirs, or .zip
    python3 scripts/scan-secrets.py --json --tracked   # machine-readable
    python3 scripts/scan-secrets.py --self-test        # prove the gate can fail

Exit codes: 0 = clean (or allowlisted), 1 = findings, 2 = usage/IO error.

Allowlist
---------
`.secretscanignore`, one rule per line:

    <rule><TAB><path-glob><TAB><reason>

Allowlisted hits are still counted and printed as a summary line — suppression
is visible, never silent. A reason is mandatory; an entry without one is an
error, because "why is this allowed" is the only part that matters later.

Values are ALWAYS redacted in output (first 4 + last 4). This script must never
print a usable secret to a terminal that might be logged.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, asdict
from pathlib import Path

# ── patterns ────────────────────────────────────────────────────────────────
# Ordered most-specific-first. `severity`:
#   CRITICAL — the value itself is a usable credential
#   HIGH     — credential-shaped, needs a human eye
#   CONTEXT  — a secret-ish key name with a long value (assignment-shaped)
CRED = [
    # provider keys
    ("openai-key",      re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}"),               "CRITICAL"),
    ("anthropic-key",   re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),                            "CRITICAL"),
    ("stripe-key",      re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}"),              "CRITICAL"),
    ("github-pat",      re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),                          "CRITICAL"),
    ("github-fine-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b"),                        "CRITICAL"),
    ("google-api-key",  re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),                              "CRITICAL"),
    ("aws-access-key",  re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),                           "CRITICAL"),
    ("slack-token",     re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b"),                       "CRITICAL"),
    ("telegram-bot",    re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{30,}\b"),                      "CRITICAL"),
    ("jwt",             re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "HIGH"),
    ("private-key",     re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),  "CRITICAL"),
    ("bearer-literal",  re.compile(r"\bBearer\s+([A-Za-z0-9_\-\.]{24,})"),                      "HIGH"),
    # assignment-shaped: key name + long opaque value
    ("secret-assign",   re.compile(
        r"""(?ix)\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|"""
        r"""client[_-]?secret|private[_-]?key|password|passwd|pwd|refresh[_-]?token)"""
        r"""\s*[:=]\s*['"]?([A-Za-z0-9_\-\.\+/]{16,})['"]?"""),                                 "CONTEXT"),
]

# Values that match the shapes above but are obviously not credentials. Keeping
# these out of the report is what makes the report readable — and what keeps the
# gate green on a clean tree, which is the only state in which anyone will keep
# reading it.
PLACEHOLDER = re.compile(
    r"(?i)^(?:your|my|test|dummy|fake|example|sample|placeholder|changeme|xxx+|\d+xx+|"
    r"\.\.\.|<|\$|\{\{|redacted|todo|none|null|undefined|sk-xxx|abc123|0{8,})"
)
# A 20+ char credential body with fewer than 8 distinct characters is synthetic
# (`sk-9router-xxxxxxxxxxxx`, `sk-test-0000...`), not a real key.
MIN_DISTINCT = 8
# Strip these before placeholder matching, so `Bearer your-api-key-here` is
# recognised as the placeholder it is instead of being reported forever.
STRIP_PREFIX = re.compile(r"(?i)^(?:bearer|token|basic)\s+")

TEXT_EXT = {
    ".md", ".txt", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".example", ".sh",
    ".bash", ".zsh", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".php", ".sql",
    ".html", ".css", ".scss", ".xml", ".svg", ".csv", ".log", ".gitignore",
    ".gitattributes", ".npmrc", ".editorconfig", ".properties", ".gradle",
}
# Extensionless-but-textual names worth reading.
TEXT_NAMES = {
    "env", ".env", ".env.example", ".env.local", ".env.production", "dockerfile",
    "makefile", "procfile", "license", "readme", "changelog", "cara-pakai",
    "notes", ".npmrc", ".gitignore", ".gitattributes",
}
SKIP_DIRS = {
    ".git", "node_modules", ".next", "dist", "build", "coverage", "__pycache__",
    ".venv", "venv", "env", ".pytest_cache", ".turbo", ".cache", "vendor",
    ".engine",  # staged copy of the private engine; scanned at its own source
}
SKIP_FILE_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
                    ".zip", ".gz", ".tgz", ".7z", ".woff", ".woff2", ".ttf",
                    ".otf", ".eot", ".mp3", ".mp4", ".wav", ".wasm", ".so",
                    ".dylib", ".dll", ".exe", ".bin", ".node", ".map"}

MAX_BYTES = 4 * 1024 * 1024  # skip anything larger; not a config file
ALLOW_FILE = ".secretscanignore"


@dataclass
class Finding:
    origin: str      # path, or "zip::member" for archive members
    line: int
    rule: str
    severity: str
    redacted: str


def redact(value: str) -> str:
    """Never emit a usable secret. First 4 + last 4, elided middle."""
    v = value.strip().strip("'\"")
    if len(v) <= 10:
        return "*" * len(v)
    return f"{v[:4]}{'*' * min(12, len(v) - 8)}{v[-4:]}"


def looks_like_placeholder(value: str) -> bool:
    v = STRIP_PREFIX.sub("", value.strip().strip("'\"")).strip()
    if PLACEHOLDER.match(v):
        return True
    body = v.split("-", 1)[1] if v.startswith("sk-") else v
    body = body.replace("-", "").replace("_", "")
    return len(body) >= 16 and len(set(body)) < MIN_DISTINCT


def looks_textual(name: str) -> bool:
    base = os.path.basename(name).lower()
    if base in TEXT_NAMES:
        return True
    suffix = os.path.splitext(base)[1].lower()
    if suffix in SKIP_FILE_SUFFIX:
        return False
    return suffix in TEXT_EXT or suffix == "" and "." not in base


def load_allowlist(path: Path) -> list[tuple[str, str, str]]:
    """rule, path-glob, reason. A missing reason is a hard error: the reason is
    the only part of the entry that still carries information a year from now."""
    if not path.exists():
        return []
    rules = []
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 3 or not all(parts[:3]):
            raise SystemExit(f"{path}:{n}: expected '<rule>\\t<path-glob>\\t<reason>'")
        rules.append((parts[0], parts[1], parts[2]))
    return rules


def allowlisted(f: Finding, rules: list[tuple[str, str, str]]) -> str | None:
    rel = f.origin.split("::", 1)[0]
    for rule, glob, reason in rules:
        if rule in ("*", f.rule) and fnmatch.fnmatch(rel, glob):
            return reason
    return None


def scan_text(text: str, origin: str, findings: list[Finding]) -> None:
    for lineno, line in enumerate(text.splitlines(), 1):
        for rule, pattern, severity in CRED:
            for m in pattern.finditer(line):
                # group(1) when the rule has a capture, else the whole match
                value = m.group(1) if m.lastindex else m.group(0)
                if looks_like_placeholder(value):
                    continue
                findings.append(Finding(origin, lineno, rule, severity, redact(value)))


def scan_file(path: Path, findings: list[Finding]) -> None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return
        scan_text(path.read_text(encoding="utf-8", errors="replace"), str(path), findings)
    except OSError as exc:
        print(f"warn: cannot read {path}: {exc}", file=sys.stderr)


def scan_zip(path: Path, findings: list[Finding]) -> None:
    """The artifact that actually ships: read members in-memory."""
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir() or info.file_size > MAX_BYTES:
                    continue
                if not looks_textual(info.filename):
                    continue
                try:
                    data = zf.read(info).decode("utf-8", errors="replace")
                except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    print(f"warn: cannot read {info.filename} in {path}: {exc}", file=sys.stderr)
                    continue
                scan_text(data, f"{path}::{info.filename}", findings)
    except (zipfile.BadZipFile, OSError) as exc:
        print(f"warn: cannot open zip {path}: {exc}", file=sys.stderr)


def tracked_files() -> list[Path]:
    """What actually gets published. Scanning the working tree finds leaked keys
    in gitignored scratch files and buries the ones that matter."""
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [Path(p) for p in out.decode().split("\0") if p]


def walk(target: Path, findings: list[Finding]) -> tuple[int, int]:
    files = zips = 0
    if target.is_file():
        if target.suffix.lower() == ".zip":
            scan_zip(target, findings)
            return 0, 1
        scan_file(target, findings)
        return 1, 0
    for root, dirs, names in os.walk(target):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            p = Path(root) / name
            if p.suffix.lower() == ".zip":
                scan_zip(p, findings)
                zips += 1
            elif looks_textual(name):
                scan_file(p, findings)
                files += 1
    return files, zips


# ── self-test ───────────────────────────────────────────────────────────────
# A gate that cannot fail is not a gate. This plants credentials the shapes are
# supposed to catch, in both a plain file and inside a ZIP, and asserts the
# scanner reports them — plus a clean file and a placeholder it must NOT report.
PLANTED = [
    "sk-proj-AbCdEf0123456789AbCdEf0123456789",
    "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    # AKIA + exactly 16 uppercase alnum. The AWS doc example
    # `AKIAIOSFODNN7EXAMPLE` is 21 chars and does NOT match the real 20-char
    # shape — a fixture built from it would prove nothing about the rule.
    "AKIA" + "IOSFODNN7EXAMPLE"[:16],
    "-----BEGIN RSA PRIVATE KEY-----",
]
CLEAN = "const greeting = 'hello';\n// no credentials here\n"
PLACEHOLDER_LINE = "API Key: sk-9router-xxxxxxxxxxxx\n"


def self_test() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "planted.txt").write_text("\n".join(PLANTED) + "\n", encoding="utf-8")
        (root / "clean.txt").write_text(CLEAN, encoding="utf-8")
        (root / "placeholder.txt").write_text(PLACEHOLDER_LINE, encoding="utf-8")
        with zipfile.ZipFile(root / "planted.zip", "w") as zf:
            zf.writestr("inner/config.js", f'const KEY = "{PLANTED[0]}";\n')
            zf.writestr("inner/logo.png", PLANTED[0].encode())  # binary: must be skipped

        findings: list[Finding] = []
        files, zips = walk(root, findings)
        got = {(f.rule, f.origin.split("::")[0].split("/")[-1]) for f in findings}
        want = {
            ("openai-key", "planted.txt"),
            ("github-pat", "planted.txt"),
            ("aws-access-key", "planted.txt"),
            ("private-key", "planted.txt"),
            ("openai-key", "planted.zip"),
        }
        missing = want - got
        wrong = {(r, o) for r, o in got if o in ("clean.txt", "placeholder.txt")}
        checks = [
            ("planted credentials detected", not missing),
            ("clean file not flagged", not wrong),
            ("placeholder suppressed", ("openai-key", "placeholder.txt") not in got),
            ("binary zip member skipped", len([f for f in findings if f.origin.endswith(".png")]) == 0),
            ("tree was walked", files >= 3 and zips == 1),
        ]
        for label, ok in checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        if missing:
            print(f"  missing: {sorted(missing)}")
        if wrong:
            print(f"  false positives: {sorted(wrong)}")
        bad = [c for c, ok in checks if not ok]
        print(f"self-test: {'PASS' if not bad else 'FAIL'} ({len(checks) - len(bad)}/{len(checks)})")
        return 0 if not bad else 1


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Scan repo/pack trees for leaked credentials.")
    ap.add_argument("targets", nargs="*", help="files, directories or .zip archives")
    ap.add_argument("--tracked", action="store_true", help="scan git-tracked files only (CI mode)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument("--all", action="store_true",
                    help="also report CONTEXT-severity assignment matches (noisier)")
    ap.add_argument("--self-test", action="store_true", help="verify the gate can detect fixtures")
    ap.add_argument("--ignore-file", default=ALLOW_FILE, help=f"allowlist path (default {ALLOW_FILE})")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.targets and not args.tracked:
        ap.error("give at least one target, or --tracked")

    findings: list[Finding] = []
    scanned = {"files": 0, "zips": 0}
    if args.tracked:
        for p in tracked_files():
            if p.suffix.lower() == ".zip":
                scan_zip(p, findings)
                scanned["zips"] += 1
            elif looks_textual(p.name):
                scan_file(p, findings)
                scanned["files"] += 1
    for t in args.targets:
        p = Path(t)
        if not p.exists():
            print(f"error: no such path: {t}", file=sys.stderr)
            return 2
        f, z = walk(p, findings)
        scanned["files"] += f
        scanned["zips"] += z

    rules = load_allowlist(Path(args.ignore_file))
    suppressed: dict[str, int] = {}
    kept: list[Finding] = []
    for f in findings:
        reason = allowlisted(f, rules)
        if reason:
            suppressed[f"{f.rule} ({reason})"] = suppressed.get(f"{f.rule} ({reason})", 0) + 1
        elif args.all or f.severity != "CONTEXT":
            kept.append(f)
    kept.sort(key=lambda x: ({"CRITICAL": 0, "HIGH": 1, "CONTEXT": 2}[x.severity], x.origin, x.line))

    if args.json:
        print(json.dumps({
            "scanned": scanned,
            "findings": [asdict(f) for f in kept],
            "allowlisted": suppressed,
            "suppressed_context": len(findings) - len(kept) - sum(suppressed.values()),
        }, indent=2))
    else:
        print(f"scanned: {scanned['files']} files, {scanned['zips']} archives")
        for key, n in sorted(suppressed.items()):
            print(f"  allowlisted: {key} x{n}")
        if not kept:
            print("CLEAN — no credential-shaped strings found")
        else:
            print(f"FINDINGS: {len(kept)}")
            for f in kept:
                print(f"  [{f.severity}] {f.rule:16s} {f.origin}:{f.line}  {f.redacted}")

    return 1 if kept else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
