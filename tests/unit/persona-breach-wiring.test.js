// Guards for persona-breach wiring (registry K28, 2026-10-02).
//
// THE DEFECT THIS PREVENTS. The engine's own suite proves the classifier works
// (tests/personaBreach.test.mjs, 24 cases). It proves nothing about whether
// anybody CALLS it — and this repo has already paid for that class once:
// engine-dead-wiring.test.js exists because six features were implemented,
// tested, and called from nowhere.
//
// So these tests assert the CALL SITES. Both response paths must assess, and
// both must be guarded so a telemetry failure can never break a reply.
//
// The second half is the K18 shape. The module ships a fallback that answers
// "no attempt" when the bundle is absent; if a future edit wires the verdict
// into a BLOCK (reject the request, escalate against the caller), a router that
// merely lost its engine would start refusing traffic. That is the same class
// as K21 (a guard that just came alive with the wrong threshold is worse than a
// dead one), so the wiring is asserted to be observe-only.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const STREAM = "open-sse/handlers/chatCore/streamingHandler.js";
const NONSTREAM = "open-sse/handlers/chatCore/nonStreamingHandler.js";

describe("persona breach is assessed on both response paths", () => {
  for (const file of [STREAM, NONSTREAM]) {
    const src = stripComments(read(file));

    it(`${file} imports the assessor from the engine shim`, () => {
      expect(src).toMatch(/from\s+"\.\.\/\.\.\/rtk\/personaBreach\.js"/);
      expect(src).toContain("assessPersonaBreach");
      expect(src).toContain("recordPersonaBreach");
    });

    it(`${file} actually calls assessPersonaBreach`, () => {
      expect(src).toMatch(/assessPersonaBreach\s*\(/);
    });

    it(`${file} records the verdict`, () => {
      expect(src).toMatch(/recordPersonaBreach\s*\(/);
    });

    it(`${file} wraps the call so telemetry cannot break a reply`, () => {
      // The call must sit inside a try block. Anchor on the assessor line and
      // walk backwards for the nearest `try {` before it.
      const idx = src.indexOf("assessPersonaBreach(");
      expect(idx).toBeGreaterThan(-1);
      const before = src.slice(0, idx);
      const lastTry = before.lastIndexOf("try {");
      const lastCatch = before.lastIndexOf("catch");
      expect(lastTry).toBeGreaterThan(-1);
      // `lastTry` must be AFTER the previous catch — i.e. we are inside a live
      // try block, not after a closed one.
      expect(lastTry).toBeGreaterThan(lastCatch);
    });

    it(`${file} skips persona-exempt keys (no persona to breach)`, () => {
      const idx = src.indexOf("assessPersonaBreach(");
      const before = src.slice(Math.max(0, idx - 900), idx);
      expect(before).toContain("personaExempt");
    });
  }
});

describe("the breach verdict is observe-only (K21: a live guard with a wrong action)", () => {
  for (const file of [STREAM, NONSTREAM]) {
    const src = stripComments(read(file));
    it(`${file} never uses the verdict to reject or rewrite`, () => {
      // Find every line mentioning the breach result and assert none of them
      // returns, throws, or mutates the body.
      const lines = src.split("\n").filter((l) => /\bbreach\b/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l, `breach verdict must not gate a response: ${l.trim()}`).not.toMatch(
          /\breturn\b|\bthrow\b|\.status\s*=|body\.\w+\s*=/
        );
      }
    });
  }
});

describe("the shim degrades to 'no opinion', not to 'attack'", () => {
  it("the generated fallback answers no-attempt and no-breach", () => {
    const src = read("open-sse/rtk/personaBreach.js");
    expect(src).toContain("GENERATED SHIM");
    // A fail-CLOSED fallback here would mean a bundle-less router reports every
    // request as an attack.
    expect(src).toMatch(/assessPersonaBreach\s*=\s*__E\.assessPersonaBreach\s*\?\?\s*\(\(\)\s*=>\s*\(\{[^}]*breached:\s*false/);
    expect(src).toMatch(/classifyPersonaAttack\s*=\s*__E\.classifyPersonaAttack\s*\?\?\s*\(\(\)\s*=>\s*\(\{[^}]*attempt:\s*false/);
  });
});
