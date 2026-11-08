// Unit tests for the additive prompt-cache boost (open-sse/utils/cacheBoost.js).
//
// Covers: head marking, budget protection (never exceed 4 breakpoints, never
// touch blocks the client already marked), no-op on malformed bodies, and the
// settings/env gate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyCacheBoost,
  countBreakpoints,
  isCacheBoostEnabled,
  refreshCacheBoostEnabled,
} from "../../open-sse/utils/cacheBoost.js";

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn().mockResolvedValue({ enablePromptCacheBoost: true }),
}));

describe("applyCacheBoost", () => {
  it("marks the system head and the last cacheable tool head", () => {
    const body = {
      system: [
        { type: "text", text: "x-anthropic-billing-header: tiny" },
        { type: "text", text: "Y".repeat(5000) },
      ],
      tools: [
        { name: "a", defer_loading: true },
        { name: "b" },
        { name: "c" },
      ],
      messages: [],
    };
    applyCacheBoost(body);
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[2].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].cache_control).toBeUndefined(); // small block untouched
    expect(body.tools[0].cache_control).toBeUndefined(); // defer_loading untouched
  });

  it("does nothing when the budget is already spent", () => {
    const body = {
      system: [{ type: "text", text: "Z".repeat(5000), cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "y", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const before = JSON.stringify(body);
    applyCacheBoost(body);
    expect(JSON.stringify(body)).toBe(before);
    expect(countBreakpoints(body)).toBe(4);
  });

  it("respects an existing system-head marker and still marks tools", () => {
    const sys = { type: "text", text: "K".repeat(5000), cache_control: { type: "ephemeral" } };
    const body = { system: [sys], tools: [{ name: "t" }], messages: [] };
    applyCacheBoost(body);
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(countBreakpoints(body)).toBe(2);
  });

  it("is a no-op on malformed or empty bodies", () => {
    expect(applyCacheBoost(null)).toBe(null);
    expect(applyCacheBoost({})).toEqual({});
    expect(applyCacheBoost({ system: [], tools: [], messages: [] })).toEqual({
      system: [],
      tools: [],
      messages: [],
    });
  });
});

describe("gate", () => {
  beforeEach(() => {
    delete process.env.CACHE_BOOST;
    refreshCacheBoostEnabled(); // reset module-level cache via refresh path
  });

  it("refresh enables from settings", async () => {
    expect(await refreshCacheBoostEnabled()).toBe(true);
    expect(isCacheBoostEnabled()).toBe(true);
  });

  it("env override CACHE_BOOST=1 enables even with settings off", async () => {
    process.env.CACHE_BOOST = "1";
    expect(await refreshCacheBoostEnabled()).toBe(true);
  });
});
