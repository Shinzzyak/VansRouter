// The Antigravity bulk importer failed for every account after the first with
// "Authentication script failed (exit 2) or no token file generated".
//
// Root cause, measured on production: the agy CLI keeps its OAuth session in
// ~/.gemini/antigravity-cli/antigravity-oauth-token. With a previous account's
// session still on disk, agy signs in silently and never prints an auth URL —
// the script waits out its window and exits non-zero.
//
// These tests pin the three behaviours that fix it, all of them things that
// failed for real and not in theory:
//   1. the stored session is cleared before the run
//   2. failure messages name the ACTUAL cause (agy overwrites one filename, so
//      "a new file appeared" is never a usable success signal)
//   3. a token describing a different account is refused instead of filed
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeIdTokenEmail } from "../../src/lib/oauth/services/antigravityBulkImportManager.js";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src/lib/oauth/services/antigravityBulkImportManager.js");
const src = fs.readFileSync(SRC, "utf8");

/** Build an unsigned JWT-shaped string with the given claims. */
function fakeIdToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

describe("agy session is cleared before every account", () => {
  it("removes the stored oauth token", () => {
    expect(src).toMatch(/fs\.rmSync\(f,\s*\{\s*force:\s*true\s*\}\)/);
  });

  it("clears the session BEFORE reading the pre-run file list", () => {
    // If the order were reversed the "before" snapshot would still contain the
    // stale file and the stale session would keep being reused.
    const clearIdx = src.indexOf("fs.rmSync(f,");
    const beforeIdx = src.indexOf("const tokenFilesBefore = new Set(");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(beforeIdx);
  });

  it("does not let a failed delete abort the run", () => {
    // A read-only or missing file must not stop an import.
    expect(src).toMatch(/try\s*\{\s*fs\.rmSync\(f,\s*\{\s*force:\s*true\s*\}\);\s*\}\s*catch/);
  });
});

describe("failure messages name the real cause", () => {
  it("still throws when there is no token file or a non-zero exit", () => {
    expect(src).toMatch(/if\s*\(!targetTokenFile\s*\|\|\s*exitCode\s*!==\s*0\)/);
  });

  it("distinguishes a missing file from a non-zero exit", () => {
    // The old single message blamed the script for a missing token file even
    // when the file was present — that is what made this bug hard to read.
    expect(src).toMatch(/no token file present in/);
    expect(src).toMatch(/exit code \$\{exitCode\}/);
  });

  it("no longer claims 'no token file generated' as the only explanation", () => {
    expect(src).not.toMatch(/or no token file generated/);
  });

  it("reports how many NEW files appeared, so overwriting is visible", () => {
    expect(src).toMatch(/newFiles=\$\{newTokens\.length\}/);
  });
});

describe("decodeIdTokenEmail: reading the real identity", () => {
  it("reads the email claim out of a Google id_token", () => {
    expect(decodeIdTokenEmail(fakeIdToken({ email: "justin.stewart@e-mail.bty.web.id" })))
      .toBe("justin.stewart@e-mail.bty.web.id");
  });

  it("decodes an unpadded base64url payload", () => {
    // Real Google payloads are base64url and unpadded. A plain base64 decode
    // throws on these, so this is the case worth pinning — not the alphabet.
    const tok = fakeIdToken({ email: "holder@example.com", sub: "10769150350006150715113082367" });
    expect(tok.split(".")[1]).not.toContain("=");
    expect(decodeIdTokenEmail(tok)).toBe("holder@example.com");
  });

  it("handles a payload whose length forces padding of 1 or 2 chars", () => {
    for (const pad of ["", "a", "ab", "abc"]) {
      const tok = fakeIdToken({ email: `pad${pad.length}@x.io`, extra: pad });
      expect(decodeIdTokenEmail(tok)).toBe(`pad${pad.length}@x.io`);
    }
  });

  it("returns null for junk instead of throwing", () => {
    expect(decodeIdTokenEmail("")).toBeNull();
    expect(decodeIdTokenEmail("not-a-jwt")).toBeNull();
    expect(decodeIdTokenEmail("a.b")).toBeNull();
    expect(decodeIdTokenEmail(null)).toBeNull();
    expect(decodeIdTokenEmail(undefined)).toBeNull();
  });

  it("returns null when the token carries no email claim", () => {
    expect(decodeIdTokenEmail(fakeIdToken({ sub: "123", iss: "accounts.google.com" }))).toBeNull();
    expect(decodeIdTokenEmail(fakeIdToken({ email: 42 }))).toBeNull();
  });
});

describe("a token for the wrong account is refused", () => {
  it("refuses the import when the identity disagrees", () => {
    expect(src).toMatch(/claimEmail\.toLowerCase\(\)\s*!==\s*account\.email\.toLowerCase\(\)/);
    expect(src).toMatch(/session leaked between accounts/);
  });

  it("compares case-insensitively, since Google varies the case", () => {
    const tok = fakeIdToken({ email: "Sarah.Johnson@e-mail.bty.web.id" });
    expect(decodeIdTokenEmail(tok).toLowerCase())
      .toBe("sarah.johnson@e-mail.bty.web.id");
  });

  it("does not block a successful run when the token carries no id_token", () => {
    // Access and refresh tokens alone are a valid payload; the identity check
    // must be a guard, not a new hard requirement.
    expect(src).toMatch(/const idToken = flatTokenData\.id_token \|\| tokenData\?\.id_token \|\| null;/);
    expect(src).toMatch(/if\s*\(idToken\)\s*\{/);
  });
});
