// Zero Break Guarantee: with the private engine bundle absent or corrupt, the
// router must still run as a plain [OI]-compatible proxy. Every engine import
// site degrades to a safe no-op instead of throwing.
//
// This test runs the degraded path in a CHILD process because the loader caches
// its resolution per process — flipping the env var in-process would not prove
// anything about a fresh boot.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { engineAvailable } from "./_engineAvailable.js";

const ROOT = resolve(__dirname, "../..");

// Child program: import every shim under VR_ENGINE_DISABLE and assert that
// nothing throws and that each function keeps its documented shape.
const CHILD = `
const out = {};
const g = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/godmode.js"))});
const b = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/bypassEngine.js"))});
const p = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/promptInjectors.js"))});
const t = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/potatoMechanics.js"))});
const c = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/compactionReassert.js"))});
const i = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/instructionPlan.js"))});
const r = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/responseIntegrity.js"))});
const l = await import(${JSON.stringify(resolve(ROOT, "open-sse/rtk/engineLoader.js"))});

out.loaded = l.isEngineLoaded();
out.bundlePath = l.engineBundlePath();

// Body-mutating injectors must leave the body untouched.
const body = { messages: [{ role: "user", content: "hi" }] };
const before = JSON.stringify(body);
g.injectPersonaLock(body, "openai");
g.injectGodmode(body, "openai", true);
t.injectPotatoMechanics(body, "openai");
c.reassertPersonaAfterCompaction(body, "openai");
out.bodyUntouched = JSON.stringify(body) === before;

// Classifiers must report "nothing wrong" instead of guessing.
out.refusal = b.detectRefusal("I cannot help with that");
out.filtered = b.isOutputFiltered({ choices: [] });
out.escalation = b.getEscalationPrompt(1);
out.family = b.detectModelFamily("gemini-3.8-flash");
out.bypass = b.applyBypass(body, "openai", "x", "y");

// Compaction + plan.
out.compaction = c.detectCompactionHandoff(body);
out.plan = i.buildInstructionPlan({ godmodeEnabled: true, godmodeText: "x" });

// Response integrity must still classify a clean body as ok (never refuse to run).
out.classify = r.classifyResponse({ parsed: { choices: [{ message: { content: "hello" } }] } });
out.repair = r.repairBrandContract("hello");

// Constants keep their shape so property access never throws.
out.levels = Array.isArray(g.GODMODE_LEVELS);
out.modes = b.BYPASS_MODES.AGGRESSIVE;
out.integrity = r.INTEGRITY.OK;
out.blockIds = i.BLOCK_IDS.POTATO;
out.persona = g.PERSONA_LOCK_PROMPT;
out.marker = t.POTATO_MECHANICS_MARKER;

console.log(JSON.stringify(out));
`;

function runChild(env = {}) {
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

describe("engine fail-open (Zero Break Guarantee)", () => {
  describe("with the engine bundle disabled", () => {
    const out = runChild({ VR_ENGINE_DISABLE: "1" });

    it("reports the engine as absent", () => {
      expect(out.loaded).toBe(false);
      expect(out.bundlePath).toBe(null);
    });

    it("leaves the request body byte-identical", () => {
      expect(out.bodyUntouched).toBe(true);
    });

    it("classifies conservatively instead of guessing", () => {
      expect(out.refusal).toBe(false);
      expect(out.filtered).toBe(false);
      expect(out.escalation).toBe(null);
      expect(out.family).toBe(null);
      expect(out.compaction).toBe(false);
    });

    it("keeps injector constants at their safe values", () => {
      expect(out.persona).toBe("");
      expect(out.marker).toBe("");
      expect(out.levels).toBe(true); // GODMODE_LEVELS is still an array, just empty
      expect(out.modes).toBe("aggressive");
      expect(out.integrity).toBe("ok");
      expect(out.blockIds).toBe("potato");
    });

    it("still returns a well-formed plan so receipts do not crash", () => {
      expect(out.plan).toBeTruthy();
      expect(Array.isArray(out.plan.blocks)).toBe(true);
      expect(out.plan.engineMissing).toBe(true);
    });

    it("never claims a clean response is broken", () => {
      expect(out.classify.status).toBe("ok");
      expect(out.classify.refusal).toBe(false);
      expect(out.repair.repaired).toBe(false);
    });
  });

  // Only runs where the private bundle exists (dev machine / VPS). On CI the
  // bundle is absent by design, so this block skips — the disabled block above
  // is the one that must pass everywhere.
  describe.skipIf(!engineAvailable())("with the engine bundle present", () => {
    const out = runChild();

    it("loads the private bundle", () => {
      expect(out.loaded).toBe(true);
      expect(out.bundlePath).toMatch(/data\/engine\/engine\.cjs$/);
    });

    it("actually detects a refusal", () => {
      expect(out.refusal).toBe(true);
    });

    it("actually identifies a model family", () => {
      expect(out.family).toBeTruthy();
    });

    it("injects the real persona lock", () => {
      expect(out.persona).toContain("GEFREITER");
      expect(out.marker).toContain("POTATO MECHANICS");
    });

    it("returns a populated instruction plan", () => {
      expect(out.plan.blocks.length).toBeGreaterThan(0);
      expect(out.plan.engineMissing).toBeUndefined();
    });
  });
});
