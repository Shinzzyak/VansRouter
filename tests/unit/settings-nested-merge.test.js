import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression cover for the nested-map merge in updateSettings().
//
// The bug this guards: updateSettings() did `{ ...current, ...updates }`, a
// TOP-LEVEL spread. Any PATCH whose body carried `capacityAdapter` therefore
// replaced the whole map, so sub-keys the caller did not mention (compact,
// thinking, execution) were dropped from the row. getSettings() then
// re-supplied them from DEFAULT_SETTINGS, where `compact.enabled` is false —
// silently switching an enabled compact adapter back off.
//
// These tests exercise the merge helper directly, so they do not need a live
// DB adapter.
// ---------------------------------------------------------------------------

const { mergeNestedSettingsMap } = await import("../../src/lib/db/repos/settingsRepo.js");

const DEFAULT_SHAPE = {
  vision: { enabled: true, roundRobin: false, models: [] },
  pdf: { enabled: false, roundRobin: false, models: [] },
  audioInput: { enabled: true, roundRobin: false, models: [] },
  videoInput: { enabled: false, roundRobin: false, models: [] },
};

describe("mergeNestedSettingsMap", () => {
  it("keeps sub-keys the caller did not mention", () => {
    const current = {
      ...DEFAULT_SHAPE,
      compact: { enabled: true, roundRobin: false, models: ["smart-fallback"] },
    };
    // A dashboard save that only knows about vision must not drop compact.
    const incoming = { vision: { enabled: false, roundRobin: false, models: ["ag/gemini-3.5-flash"] } };

    const merged = mergeNestedSettingsMap(current, incoming);

    expect(merged.compact).toEqual({ enabled: true, roundRobin: false, models: ["smart-fallback"] });
    expect(merged.vision.enabled).toBe(false);
    expect(merged.vision.models).toEqual(["ag/gemini-3.5-flash"]);
  });

  it("merges a mentioned sub-key field-by-field instead of replacing it", () => {
    const current = { compact: { enabled: true, roundRobin: true, models: ["a"] } };
    const incoming = { compact: { enabled: false } };

    const merged = mergeNestedSettingsMap(current, incoming);

    // enabled flips, but models/roundRobin survive — a partial patch stays partial.
    expect(merged.compact).toEqual({ enabled: false, roundRobin: true, models: ["a"] });
  });

  it("adds sub-keys that did not exist before", () => {
    const merged = mergeNestedSettingsMap({ vision: { enabled: true } }, { brandNew: { enabled: true } });
    expect(merged.brandNew).toEqual({ enabled: true });
  });

  it("replaces non-object values rather than merging into them", () => {
    const merged = mergeNestedSettingsMap({ vision: { enabled: true } }, { vision: null });
    expect(merged.vision).toBe(null);
  });

  it("returns a new object and leaves both inputs untouched", () => {
    const current = { compact: { enabled: true } };
    const incoming = { vision: { enabled: false } };
    const snapCurrent = JSON.stringify(current);
    const snapIncoming = JSON.stringify(incoming);

    const merged = mergeNestedSettingsMap(current, incoming);

    expect(merged).not.toBe(current);
    expect(JSON.stringify(current)).toBe(snapCurrent);
    expect(JSON.stringify(incoming)).toBe(snapIncoming);
  });

  it("handles missing/undefined inputs without throwing", () => {
    expect(mergeNestedSettingsMap(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
    expect(mergeNestedSettingsMap({ a: { b: 1 } }, undefined)).toEqual({ a: { b: 1 } });
    expect(mergeNestedSettingsMap(undefined, undefined)).toEqual({});
  });

  it("survives a hostile __proto__ payload without polluting Object.prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}');
    mergeNestedSettingsMap({}, hostile);
    expect({}.polluted).toBeUndefined();
  });
});
