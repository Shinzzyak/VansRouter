import { describe, it, expect, vi } from "vitest";
import { buildCacheKey, extractPromptText } from "@/lib/semanticcache/key.js";
import { LruStore } from "@/lib/semanticcache/store.js";
import { SemanticCache, estimateTokens } from "@/lib/semanticcache/cache.js";

/** Minimal well-formed request. */
function request(overrides = {}) {
  return {
    model: "glm-5.3-flash:free",
    messages: [{ role: "user", content: "halo" }],
    ...overrides,
  };
}

describe("semanticcache/key — buildCacheKey", () => {
  it("is stable across two structurally identical requests", () => {
    expect(buildCacheKey(request())).toBe(buildCacheKey(request()));
  });

  it("returns an empty key for a request with no messages", () => {
    expect(buildCacheKey({ model: "m", messages: [] })).toBe("");
    expect(buildCacheKey({ model: "m" })).toBe("");
    expect(buildCacheKey(null)).toBe("");
  });

  it("separates two requests that differ only in a message body", () => {
    const a = request({ messages: [{ role: "user", content: "halo" }] });
    const b = request({ messages: [{ role: "user", content: "halo!" }] });
    expect(buildCacheKey(a)).not.toBe(buildCacheKey(b));
  });

  it("separates two requests that differ only in max_tokens", () => {
    // The defect this guards: a 16-token request served the 4096-token body.
    const small = buildCacheKey(request({ max_tokens: 16 }));
    const large = buildCacheKey(request({ max_tokens: 4096 }));
    expect(small).not.toBe(large);
  });

  it("separates a pinned parameter from an absent one", () => {
    expect(buildCacheKey(request({ temperature: 0 }))).not.toBe(buildCacheKey(request()));
    expect(buildCacheKey(request({ max_tokens: 16 }))).not.toBe(buildCacheKey(request()));
  });

  it("separates two requests that differ only in image bytes", () => {
    const withImage = (url) => request({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url } }],
      }],
    });
    expect(buildCacheKey(withImage("data:image/png;base64,AAAA")))
      .not.toBe(buildCacheKey(withImage("data:image/png;base64,BBBB")));
  });

  it("separates two requests that differ only in tool definitions", () => {
    const tool = (name) => request({ tools: [{ type: "function", function: { name } }] });
    expect(buildCacheKey(tool("read_file"))).not.toBe(buildCacheKey(tool("write_file")));
  });

  it("is insensitive to the key order of an equivalent tool definition", () => {
    const a = request({ tools: [{ type: "function", function: { name: "f", description: "d" } }] });
    const b = request({ tools: [{ function: { description: "d", name: "f" }, type: "function" }] });
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  it("separates two sessions replaying the same prompt", () => {
    expect(buildCacheKey(request(), { sessionId: "s1" }))
      .not.toBe(buildCacheKey(request(), { sessionId: "s2" }));
  });

  it("separates two models on an identical prompt", () => {
    expect(buildCacheKey(request({ model: "a" }))).not.toBe(buildCacheKey(request({ model: "b" })));
  });

  it("separates an assistant turn carrying tool_calls", () => {
    const base = [{ role: "user", content: "hi" }];
    const a = buildCacheKey(request({ messages: [...base, { role: "assistant", content: "" }] }));
    const b = buildCacheKey(request({
      messages: [...base, { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "f" } }] }],
    }));
    expect(a).not.toBe(b);
  });

  it("is a 64-character hex digest", () => {
    expect(buildCacheKey(request())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("semanticcache/key — extractPromptText", () => {
  it("reads text blocks and skips non-text blocks", () => {
    const text = extractPromptText({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "hello " }, { type: "image_url", image_url: { url: "u" } }, { type: "text", text: "world" }],
      }],
    });
    expect(text).toBe("user:hello world");
  });

  it("returns empty for a request without messages", () => {
    expect(extractPromptText(null)).toBe("");
  });
});

describe("semanticcache/store — LruStore", () => {
  const entry = (model = "m") => ({ model, body: "{}", contentType: "application/json", storedAt: Date.now(), hitCount: 0, tokensSaved: 0 });

  it("evicts the least recently used key once the bound is reached", () => {
    const store = new LruStore(2, 0);
    store.put("a", entry());
    store.put("b", entry());
    store.get("a"); // a becomes the most recently used
    store.put("c", entry()); // b is the oldest and goes

    expect(store.get("b")).toBeNull();
    expect(store.get("a")).not.toBeNull();
    expect(store.get("c")).not.toBeNull();
    expect(store.len()).toBe(2);
  });

  it("treats an expired entry as a miss and drops it", () => {
    const store = new LruStore(10, 1000);
    store.put("a", { ...entry(), storedAt: Date.now() - 5000 });
    expect(store.get("a")).toBeNull();
    expect(store.len()).toBe(0);
  });

  it("invalidateByModel removes only that model", () => {
    const store = new LruStore(10, 0);
    store.put("a", entry("x"));
    store.put("b", entry("y"));
    expect(store.invalidateByModel("x")).toBe(1);
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).not.toBeNull();
  });

  it("invalidateOlderThan removes only stale entries", () => {
    const store = new LruStore(10, 0);
    store.put("old", { ...entry(), storedAt: Date.now() - 60_000 });
    store.put("new", entry());
    expect(store.invalidateOlderThan(30_000)).toBe(1);
    expect(store.get("new")).not.toBeNull();
  });

  it("recordHit bumps the counters for a present key only", () => {
    const store = new LruStore(10, 0);
    store.put("a", entry());
    store.recordHit("a", 42);
    store.recordHit("missing", 42);
    expect(store.get("a").hitCount).toBe(1);
    expect(store.get("a").tokensSaved).toBe(42);
  });
});

describe("semanticcache/cache — SemanticCache", () => {
  it("is inert until enabled", () => {
    const cache = new SemanticCache();
    expect(cache.enabled()).toBe(false);
    expect(cache.put(request(), "{}")).toBe(false);
    expect(cache.lookup(request())).toEqual({ hit: false });
  });

  it("serves a stored body back on an identical request", () => {
    const cache = new SemanticCache({ enabled: true });
    expect(cache.put(request(), '{"ok":true}')).toBe(true);

    const found = cache.lookup(request());
    expect(found.hit).toBe(true);
    expect(found.body).toBe('{"ok":true}');
  });

  it("does not serve a body across a differing shaping parameter", () => {
    const cache = new SemanticCache({ enabled: true });
    cache.put(request({ max_tokens: 4096 }), '{"ok":true}');
    expect(cache.lookup(request({ max_tokens: 16 })).hit).toBe(false);
  });

  it("never caches a streaming request", () => {
    const cache = new SemanticCache({ enabled: true });
    expect(cache.put(request({ stream: true }), "{}")).toBe(false);
    expect(cache.lookup(request({ stream: true })).hit).toBe(false);
  });

  it("never caches a non-2xx body", () => {
    const cache = new SemanticCache({ enabled: true });
    expect(cache.put(request(), '{"error":"nope"}', { status: 500 })).toBe(false);
    expect(cache.put(request(), "", { status: 200 })).toBe(false);
  });

  it("counts a hit, a miss and the tokens saved", () => {
    const cache = new SemanticCache({ enabled: true });
    cache.put(request(), JSON.stringify({ usage: { total_tokens: 250 } }));
    cache.lookup(request());
    cache.lookup(request({ messages: [{ role: "user", content: "different" }] }));

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe("50.0");
    expect(stats.tokensSaved).toBe(250);
  });

  it("lets an injected predicate override the static flag", () => {
    let on = false;
    const cache = new SemanticCache({ enabled: true, enabledFn: () => on });
    expect(cache.enabled()).toBe(false);
    on = true;
    expect(cache.enabled()).toBe(true);
  });

  it("paginates and filters entry metadata without leaking bodies", () => {
    const cache = new SemanticCache({ enabled: true, maxEntries: 10 });
    for (let i = 0; i < 5; i += 1) {
      cache.put(request({ model: `m${i}`, messages: [{ role: "user", content: `p${i}` }] }), "{}");
    }

    const page = cache.listEntries({ limit: 2, page: 1 });
    expect(page.total).toBe(5);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).not.toHaveProperty("body");

    const filtered = cache.listEntries({ model: "m3" });
    expect(filtered.total).toBe(1);
    expect(filtered.entries[0].model).toBe("m3");
  });

  it("invalidates by model and clears everything", () => {
    const cache = new SemanticCache({ enabled: true });
    cache.put(request({ model: "a" }), "{}");
    cache.put(request({ model: "b" }), "{}");

    expect(cache.invalidateByModel("a")).toBe(1);
    expect(cache.len()).toBe(1);
    cache.clear();
    expect(cache.len()).toBe(0);
  });
});

describe("semanticcache/cache — estimateTokens", () => {
  it("prefers the upstream usage block", () => {
    expect(estimateTokens(JSON.stringify({ usage: { total_tokens: 777 } }))).toBe(777);
  });

  it("falls back to a length estimate for a body without usage", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("returns 0 for an empty body", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("semanticcache/chatHook — hot-path contract", () => {
  it("does not serialise a reply while the cache is disabled", async () => {
    const { storeCachedResponse, defaultCache } = await import("@/lib/semanticcache/chatHook.js");
    const previous = defaultCache.enabledFn;
    defaultCache.enabledFn = () => false;

    const spy = vi.spyOn(JSON, "stringify");
    const finalResponse = { id: "chatcmpl-x", choices: [{ message: { content: "hello" } }] };
    const stored = storeCachedResponse({
      requestBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
      finalResponse,
    });
    const serialisedOurReply = spy.mock.calls.some(([arg]) => arg === finalResponse);

    spy.mockRestore();
    defaultCache.enabledFn = previous;

    expect(stored).toBe(false);
    // The whole point: a disabled cache must cost nothing on the reply path.
    expect(serialisedOurReply).toBe(false);
  });
});
