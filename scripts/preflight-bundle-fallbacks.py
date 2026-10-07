#!/usr/bin/env python3
"""Pre-flight the bundle verifier LOCALLY, so a missing fallback costs seconds
instead of a 5-minute CI round trip.

The CI step that failed (2026-10-07) reported:

    FAIL lexicalHygiene: missing=[] extra=[] noFallback=["instructionLeakAxes"]

i.e. an engine export existed with no declared fallback in FALLBACKS.

How this differs from the CI verifier, on purpose: CI imports open-sse/rtk/<m>.js
AFTER the private engine sources have been hydrated there. Locally those files are
shims, so the export surface is read from the ENGINE checkout instead, via the
staged tree that scripts/run-engine-suite.sh already builds.

An earlier version of this script regex-parsed `export` lines and reported two
false FAILs (promptInjectors.BYPASS_MODES is a RE-EXPORT, routeGuardMemory has
stale declared-but-unused fallbacks). Module namespaces are the only honest
source, so this version imports them. Stale declarations are reported as INFO —
CI tolerates them (it only checks that every real export HAS a fallback).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path("/home/ubuntu/VansRouter")
STAGE = Path("/tmp/rs/stage_k57b/src")
SRC = ROOT / "scripts" / "engine-bundle.mjs"

text = SRC.read_text()
m = re.search(r"const ENGINE_MODULES = \[(.*?)\];", text, re.S)
modules = re.findall(r'"([^"]+)"', m.group(1))


def brace_block(src: str, key: str) -> str:
    """Return the {...} body that follows `const <key> = {`."""
    start = src.index(f"const {key} = {{")
    i = src.index("{", start)
    depth, j = 0, i
    while True:
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return src[i + 1:j]


block = brace_block(text, "FALLBACKS")
fallbacks = {}
for mm in re.finditer(r"^  (\w+): \{", block, re.M):
    mod = mm.group(1)
    k, d = mm.end() - 1, 0
    while True:
        if block[k] == "{":
            d += 1
        elif block[k] == "}":
            d -= 1
            if d == 0:
                break
        k += 1
    fallbacks[mod] = set(re.findall(r"^\s{4}(\w+):", block[mm.end():k], re.M))

# One node call for every module namespace — the same source of truth CI uses.
js = (
    "(async () => { const out = {};"
    " for (const m of " + json.dumps(modules) + ") {"
    "  try { const ns = await import('file://' + process.argv[1] + '/' + m + '.js');"
    "    out[m] = Object.keys(ns).filter(k => k !== 'default').sort(); }"
    "  catch (e) { out[m] = { error: e.message.split('\\n')[0] }; } }"
    " console.log(JSON.stringify(out)); })();"
)
proc = subprocess.run(["node", "-e", js, str(STAGE)], capture_output=True, text=True)
if proc.returncode != 0:
    print("node failed:", proc.stderr.strip()[:400])
    sys.exit(2)
surface = json.loads(proc.stdout)

bad, skipped, stale = [], [], []
for mod in modules:
    got = surface.get(mod)
    if got is None or isinstance(got, dict):
        skipped.append((mod, got.get("error") if isinstance(got, dict) else "not staged"))
        continue
    declared = fallbacks.get(mod, set())
    no_fb = sorted(set(got) - declared)
    if no_fb:
        bad.append((mod, no_fb))
        print(f"FAIL {mod}: noFallback={no_fb}")
    else:
        print(f"  ok {mod} — {len(got)} exports, all with declared fallbacks")
    dead = sorted(declared - set(got))
    if dead:
        stale.append((mod, dead))

print()
print(f"modules checked : {len(modules) - len(skipped)}")
if stale:
    print("INFO stale fallbacks (declared, never exported — CI tolerates these):")
    for mod, dead in stale:
        print(f"  {mod}: {dead}")
if skipped:
    print(f"modules SKIPPED (not in the staged tree): {len(skipped)}")
    for mod, why in skipped:
        print(f"  {mod}: {why}")
print()
print("VERDICT:", "FAIL" if bad else "PASS")
sys.exit(1 if bad else 0)
