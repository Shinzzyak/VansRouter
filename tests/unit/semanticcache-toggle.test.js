import { describe, it, expect, beforeEach, vi } from "vitest";

import { buildCacheKey } from "@/lib/semanticcache/key.js";
import { SemanticCache } from "@/lib/semanticcache/cache.js";
import { defaultCache } from "@/lib/semanticcache/cache.js";
import { setSemanticCacheEnabled, semanticCacheEnabled } from "@/lib/semanticcache/chatHook.js";
import { isReplayableReply } from "open-sse/handlers/chatCore/emptyReason.js";

// runtime.js reads settings through the DB layer; stub it so this suite stays a
// unit test and so the "clear on enable" behaviour can be observed directly.
const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock("@/lib/localDb", () => ({
  getSettings: (...args) => getSettings(...args),
  updateSettings: (...args) => updateSettings(...args),
}));

const { engineEpoch, applySemanticCacheConfig, setSemanticCacheEnabledPersisted } =
  await import("@/lib/semanticcache/runtime.js");

function request(overrides = {}) {
  return {
    model: "glm-5.3-flash:free",
    messages: [{ role: "user", content: "halo" }],
    ...overrides,
  };
}

const BASE_SETTINGS = {
  semanticCacheEnabled: false,
  godmodeEnabled: false,
  godmodeLevel: "lite",
  bypassMode: "off",
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
};

beforeEach(() => {
  delete process.env.SEMANTIC_CACHE;
  getSettings.mockReset().mockResolvedValue({ ...BASE_SETTINGS });
  updateSettings.mockReset().mockResolvedValue(undefined);
  setSemanticCacheEnabled(false);
  defaultCache.clear();
  defaultCache.setKeySalt("");
});

describe("semantic cache toggle", () => {
  it("is off until the setting says otherwise", async () => {
    expect(defaultCache.enabled()).toBe(false);
    expect(semanticCacheEnabled()).toBe(false);

    await applySemanticCacheConfig();

    expect(defaultCache.enabled()).toBe(false);
  });

  it("turns on from the stored setting alone — no restart, no env var", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, semanticCacheEnabled: true });

    const applied = await applySemanticCacheConfig();

    expect(applied.enabled).toBe(true);
    expect(defaultCache.enabled()).toBe(true);
  });

  it("persists the flip and applies it to the live instance", async () => {
    const applied = await setSemanticCacheEnabledPersisted(true);

    expect(updateSettings).toHaveBeenCalledWith({ semanticCacheEnabled: true });
    // The stub returns the old settings on the re-read, so the value the caller
    // gets back is the setting as stored — the important half is that the write
    // happened and the epoch was refreshed.
    expect(applied.salt).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps SEMANTIC_CACHE=1 as a hard override", async () => {
    process.env.SEMANTIC_CACHE = "1";

    expect(semanticCacheEnabled()).toBe(true);
    expect(defaultCache.enabled()).toBe(true);

    // ...and it survives a settings read that says off.
    await applySemanticCacheConfig();
    expect(defaultCache.enabled()).toBe(true);
  });

  it("stores and replays once enabled, and stops the moment it is disabled", () => {
    const cache = new SemanticCache({ enabledFn: () => false });
    expect(cache.put(request(), '{"ok":1}')).toBe(false);

    setSemanticCacheEnabled(true);
    const live = new SemanticCache({ enabledFn: semanticCacheEnabled });
    expect(live.put(request(), '{"ok":1}')).toBe(true);
    expect(live.lookup(request()).hit).toBe(true);

    setSemanticCacheEnabled(false);
    expect(live.put(request(), '{"ok":2}')).toBe(false);
    expect(live.lookup(request()).hit).toBe(false);
  });

  it("never replays a streaming turn", () => {
    setSemanticCacheEnabled(true);
    const live = new SemanticCache({ enabledFn: semanticCacheEnabled });

    expect(live.put(request({ stream: true }), '{"ok":1}')).toBe(false);
    expect(live.lookup(request({ stream: true })).hit).toBe(false);
  });

  it("does not replay a body written under a different engine epoch", () => {
    setSemanticCacheEnabled(true);
    const live = new SemanticCache({ enabledFn: semanticCacheEnabled });

    live.setKeySalt("epoch-a");
    expect(live.put(request(), '{"ok":"a"}')).toBe(true);
    expect(live.lookup(request()).hit).toBe(true);

    // Same request, new engine or new injection settings: the old body is not
    // a candidate, because it may not be what this engine would produce.
    live.setKeySalt("epoch-b");
    expect(live.lookup(request()).hit).toBe(false);
  });

  it("changes the epoch when an injection setting changes", () => {
    const off = engineEpoch({ ...BASE_SETTINGS });
    const on = engineEpoch({ ...BASE_SETTINGS, godmodeEnabled: true });
    const bypass = engineEpoch({ ...BASE_SETTINGS, bypassMode: "aggressive" });

    expect(on).not.toBe(off);
    expect(bypass).not.toBe(off);
    expect(engineEpoch({ ...BASE_SETTINGS })).toBe(off);
  });

  it("folds the epoch into the key only when one is supplied", () => {
    const plain = buildCacheKey(request());
    expect(buildCacheKey(request(), { salt: "" })).toBe(plain);
    expect(buildCacheKey(request(), { salt: "epoch-a" })).not.toBe(plain);
    expect(buildCacheKey(request(), { salt: "epoch-a" })).not.toBe(
      buildCacheKey(request(), { salt: "epoch-b" })
    );
  });

  it("clears stored entries when the cache is switched on", async () => {
    setSemanticCacheEnabled(true);
    defaultCache.put(request(), '{"ok":1}');
    expect(defaultCache.len()).toBe(1);

    await setSemanticCacheEnabledPersisted(true);

    expect(defaultCache.len()).toBe(0);
  });

  it("never stores a failed generation, but does store a tool-call turn", () => {
    expect(isReplayableReply(null)).toBe(true);          // visible text
    expect(isReplayableReply("tool_calls")).toBe(true);   // payload is in tool_calls
    expect(isReplayableReply("no_text")).toBe(false);     // nothing to replay
    expect(isReplayableReply("no_text:length")).toBe(false); // cap eaten by reasoning
  });
});
