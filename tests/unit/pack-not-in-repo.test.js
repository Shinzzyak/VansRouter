// Anti-regression gate: the COMMERCIAL PACK sources must not be committed here.
//
// Why this file exists, and why `engine-not-in-repo.test.js` was not enough.
//
// That gate watches the ENGINE payload. It was green on 2026-09-21 while the
// sold Commercial-Pack was still anonymously fetchable from this repository's
// history at commit 2975b12b:
//
//   docs/commercial-pack-v1.2/06-hermes-internals-20260904.md  (41,475 B)
//   docs/commercial-pack-v1.2/02-router-architecture-playbook.md
//   docs/commercial-pack-v1.2/03-model-compliance-matrix.md
//   docs/ag_tokens.tsv  -- 108 Google OAuth refresh tokens
//
// 56,252 B of the v1.12 pack (19%) was byte-identical to those files, and the
// object was served by THREE repositories at once (decolua/9router,
// Vanszs/VansRouter, Shinzzyak/VansRouter) because forks share one object store.
// The file is gone from HEAD and from .gitignore-covered paths; the BYTES are
// not, because a force push does not touch unreachable objects.
//
// So this gate does two jobs the engine gate does not:
//   1. fail if pack content is tracked again (the original mistake), and
//   2. fail if a tracked file's CONTENT matches the pack, which is how the same
//      mistake arrives under a new filename.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../..");

// Paths that were committed while this repo was public. Kept as literal strings
// so the gate does not depend on .gitignore staying correct.
const FORBIDDEN_PATHS = [
  "docs/commercial-pack-v1.2/",
  "docs/ag_tokens.tsv",
  "docs/PROVIDER_FARMING_GSUITE.md",
  "docs/PROVIDER_GSUITE_ANALYSIS.md",
  "docs/opencode-bypass-handover.md",
];

// Distinctive strings that exist only inside the sold pack. Each was verified to
// have ZERO occurrences in the tracked tree before being added here; a marker
// that already appears in a fixture makes the gate fail on a clean repo.
const PACK_MARKERS = [
  "# Appendix: Hermes Internals — session loss forensics",
  "## The 3 loss classes (answer to: why mid-turn / after-compact / at-exit sessions disappear)",
  "# 13 — Private Capability Layer & CI-Built Engine",
  "# VansRouter Godmode Engine — Typed Injection Plan Architecture",
  "**Evidence class:** source-level + CI-run + live behavioral",
];

// Shapes of a leaked credential, not one specific value. A single literal would
// go stale the moment the token rotates -- which is exactly what happened to the
// 108 tokens above (all 108 now return `invalid_grant`).
//
// Vendor OAuth CLIENT SECRETS and Firebase API keys are deliberately NOT gated.
// Vendors publish their own so third-party clients can complete a login, and
// this repo ships them to make those flows work. Verified against GitHub code
// search before excluding:
//
//   GOCSPX-4uHgMPm-…  gemini-cli client secret  ~200 hits in google-gemini/gemini-cli
//   GOCSPX-K58FWR486… Antigravity client secret ~984 hits across GitHub
//   AIzaSyDsOl-1Xp…   Windsurf firebase key     ~138 hits (upstream decolua/9router)
//
// Flagging them would fail on a clean tree and teach the next reader to weaken
// the gate. What the gate is for is PER-ACCOUNT material -- refresh tokens, PATs,
// personal API keys -- which is what actually leaked (108 refresh tokens).
//
// `VENDOR_PUBLIC` is an explicit allowlist rather than a looser regex: a new
// vendor credential shows up as a failure that a human decides on, instead of
// being silently swallowed.
const VENDOR_PUBLIC = [
  /^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$/,
  /^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$/,
  /^AIzaSyDsOl-1Xp[A-Za-z0-9_-]+$/,
];

const CREDENTIAL_PATTERNS = [
  { name: "Google OAuth refresh token", re: /1\/\/0[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", re: /AIza[A-Za-z0-9_-]{35}/ },
  { name: "GitHub PAT", re: /ghp_[A-Za-z0-9]{30,}/ },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9]{30,}/ },
  { name: "JWT", re: /eyJhbGciOi[A-Za-z0-9_-]{20,}/ },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

// This file necessarily contains the markers, so it must not scan itself.
const SELF = "tests/unit/pack-not-in-repo.test.js";

describe("commercial pack is not in the repository", () => {
  it("no forbidden pack path is tracked", () => {
    const tracked = trackedFiles();
    const hits = tracked.filter((rel) =>
      FORBIDDEN_PATHS.some((bad) => rel === bad || rel.startsWith(bad))
    );
    expect(hits, `pack paths tracked again:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no tracked file contains pack content", () => {
    const hits = [];
    for (const rel of trackedFiles()) {
      if (rel === SELF) continue;
      if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|md|txt|tsv|csv|sh|py)$/.test(rel)) continue;
      let text;
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        continue; // binary or unreadable
      }
      for (const marker of PACK_MARKERS) {
        if (text.includes(marker)) hits.push(`${rel} :: ${marker}`);
      }
    }
    expect(hits, `pack content found in tracked files:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no tracked file carries a live credential shape", () => {
    const hits = [];
    for (const rel of trackedFiles()) {
      if (rel === SELF) continue;
      if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|md|txt|tsv|csv|sh|py|ya?ml|toml)$/.test(rel)) continue;
      let text;
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        continue;
      }
      for (const { name, re } of CREDENTIAL_PATTERNS) {
        // findAll, not match: a file may hold a vendor-public value AND a real
        // one, and `match` would report only the first.
        for (const m of text.matchAll(new RegExp(re.source, "g"))) {
          const value = m[0];
          if (VENDOR_PUBLIC.some((ok) => ok.test(value))) continue;
          hits.push(`${rel} :: ${name} :: ${value.slice(0, 12)}...`);
        }
      }
    }
    expect(hits, `credential shapes found in tracked files:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the .gitignore patterns that keep them out are still present", () => {
    const ignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
    // Patterns, not filenames: one filename is what lets the next farm re-add
    // the same data under a new name.
    for (const pattern of ["docs/commercial-pack-v1.2/", "docs/ag_tokens.tsv", "**/ag_tokens.tsv"]) {
      expect(ignore, `.gitignore lost the pattern ${pattern}`).toContain(pattern);
    }
  });

  it("this gate is not vacuous: it can see the tracked tree", () => {
    // A guard that reads zero files passes for the wrong reason. Pin a floor.
    const n = trackedFiles().length;
    expect(n, "git ls-files returned almost nothing -- the gate is blind").toBeGreaterThan(500);
  });
});
