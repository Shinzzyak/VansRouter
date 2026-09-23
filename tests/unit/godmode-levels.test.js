// Guards for the godmode LEVEL parameter.
//
// FINDING (2026-09-22). `injectGodmode(body, format, enabled)` documented its
// third parameter as a boolean, but every caller passes the LEVEL STRING:
//
//   promptInjectors.js:  injectGodmode(body, format, godmodeLevel || "lite", ...)
//   tests:               injectGodmode(body, "openai", true)
//
// The body only tested it for truthiness, so `lite` and `full` produced
// BYTE-IDENTICAL prompts (measured: both 11310 chars) and the dashboard's level
// picker was decorative. `max` did not exist at all — GODMODE_LEVELS had two
// entries and "maxaggressive" lived only in session notes.
//
// These tests pin the behaviour that now exists, and pin the compatibility that
// must not break: the boolean call shape still works exactly as before.
import { describe, it, expect } from "vitest";
import { isEngineLoaded } from "../../open-sse/rtk/engineLoader.js";
import {
  injectGodmode,
  normalizeGodmodeLevel,
  GODMODE_LEVELS,
} from "open-sse/rtk/godmode.js";
import { getEscalationPromptForLevel } from "open-sse/rtk/bypassEngine.js";

const mkBody = () => ({ messages: [{ role: "user", content: "x" }] });
const systemOf = (body) => body.messages.find((m) => m.role === "system")?.content || "";

describe.skipIf(!isEngineLoaded())("normalizeGodmodeLevel", () => {
  it("recognises the three real level ids", () => {
    expect(normalizeGodmodeLevel("lite")).toBe("lite");
    expect(normalizeGodmodeLevel("full")).toBe("full");
    expect(normalizeGodmodeLevel("max")).toBe("max");
  });

  it("treats falsy as 'godmode off'", () => {
    expect(normalizeGodmodeLevel(false)).toBeNull();
    expect(normalizeGodmodeLevel(undefined)).toBeNull();
    expect(normalizeGodmodeLevel(null)).toBeNull();
    expect(normalizeGodmodeLevel("")).toBeNull();
  });

  it("keeps the boolean call shape working", () => {
    // The historical call sites pass `true`. It must still enable godmode, and
    // it must land on the level they effectively got before (lite).
    expect(normalizeGodmodeLevel(true)).toBe("lite");
  });

  it("an unknown level string degrades to lite rather than disabling godmode", () => {
    // A typo in settings must not silently turn the whole layer off.
    expect(normalizeGodmodeLevel("bogus")).toBe("lite");
    expect(normalizeGodmodeLevel("MAX")).toBe("lite"); // case-sensitive on purpose
  });
});

describe.skipIf(!isEngineLoaded())("GODMODE_LEVELS describes what the code actually does", () => {
  it("lists exactly the ids normalizeGodmodeLevel accepts", () => {
    const ids = GODMODE_LEVELS.map((l) => l.id);
    expect(ids).toEqual(["lite", "full", "max"]);
    for (const id of ids) expect(normalizeGodmodeLevel(id)).toBe(id);
  });

  it("every level carries a label and a description", () => {
    for (const lvl of GODMODE_LEVELS) {
      expect(lvl.label, `${lvl.id} tanpa label`).toBeTruthy();
      expect(lvl.desc, `${lvl.id} tanpa desc`).toBeTruthy();
    }
  });
});

describe.skipIf(!isEngineLoaded())("injectGodmode applies the level", () => {
  it("godmode off injects nothing", () => {
    const body = mkBody();
    injectGodmode(body, "openai", false);
    expect(systemOf(body)).toBe("");
  });

  it("lite and full inject the same reply-surface contract", () => {
    // Documented, not accidental: `full` is reserved. The point of the test is
    // that the two are IDENTICAL on purpose, so a future edit that makes them
    // differ has to update this assertion and think about it.
    const a = mkBody(); injectGodmode(a, "openai", "lite", { chatSurface: true });
    const b = mkBody(); injectGodmode(b, "openai", "full", { chatSurface: true });
    expect(systemOf(a)).toBe(systemOf(b));
    expect(systemOf(a)).toContain("MADE BY: GEFREITER");
  });

  it("max adds the T3 layered framing on top of the lite prompt", () => {
    const lite = mkBody(); injectGodmode(lite, "openai", "lite", { chatSurface: true });
    const max = mkBody(); injectGodmode(max, "openai", "max", { chatSurface: true });
    const t3 = getEscalationPromptForLevel("T3");

    expect(t3).toBeTruthy();
    expect(systemOf(max).length).toBeGreaterThan(systemOf(lite).length);
    expect(systemOf(max).endsWith(t3)).toBe(true);
    // The base prompt is still there — max ADDS, it does not replace.
    expect(systemOf(max).startsWith(systemOf(lite))).toBe(true);
  });

  it("max does NOT touch machine-consumed traffic", () => {
    // Structured output gets GODMODE_CORE_PROMPT (no reply-shape rules). Adding
    // a reply-shaping layer there is exactly the failure the chatSurface gate
    // exists to prevent.
    const body = { messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } };
    injectGodmode(body, "openai", "max", { chatSurface: true });
    expect(systemOf(body)).not.toContain(getEscalationPromptForLevel("T3"));
  });

  it("the old boolean call shape injects the lite prompt", () => {
    const body = mkBody();
    injectGodmode(body, "openai", true);
    const lite = mkBody(); injectGodmode(lite, "openai", "lite", { chatSurface: true });
    expect(systemOf(body)).toBe(systemOf(lite));
  });
});
