import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// K146 — OpenCode free lane must not be routed through the proxy pool.
//
// Measured 2026-10-17 against the live router: one trivial
// `oc/glm-5.3-flash-free` request hung 90 s because the pool proxy died first
// ("[ProxyFetch] Proxy failed, falling back to direct: fetch failed") and only
// then went direct; the same request direct answers in 0.4-3 s.
//
// The free tier gates on REQUEST SHAPE (missing `read`/`shell` tools = 403
// FreeTierError), not on source IP, so a proxy buys nothing there.
//
// The arms assert the SHAPE of the fetch call, not its outcome: proxyFetch falls
// back to direct when the proxy dies, so a dead proxy produces an identical
// response either way. What differs is whether an undici `dispatcher` is handed
// to fetch — that is the proxy branch. `originalFetch` is captured at module load,
// so the stub sees exactly the options the real fetch would.
describe("K146 — opencode.ai free lane bypasses the proxy pool", () => {
  const calls = [];
  const stub = vi.fn(async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, headers: new Headers(), text: async () => "DIRECT", json: async () => ({}) };
  });

  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
    stub.mockClear();
    vi.stubGlobal("fetch", stub);
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  });

  afterEach(() => {
    delete process.env.HTTPS_PROXY;
    vi.unstubAllGlobals();
  });

  it("claims opencode.ai and its subdomains", async () => {
    const { staysDirect } = await import("../../open-sse/utils/proxyFetch.js");
    expect(staysDirect("https://opencode.ai/inference/v1/chat/completions")).toBe(true);
    expect(staysDirect("https://api.opencode.ai/zen/v1/chat/completions")).toBe(true);
    expect(staysDirect("https://opencode.ai:443/zen/v1/models")).toBe(true);
  });

  it("leaves lookalike hosts on the proxy path", async () => {
    const { staysDirect } = await import("../../open-sse/utils/proxyFetch.js");
    expect(staysDirect("https://notopencode.ai/v1")).toBe(false);
    expect(staysDirect("https://opencode.ai.evil.com/v1")).toBe(false);
    expect(staysDirect("https://example.com/?u=https://opencode.ai")).toBe(false);
    expect(staysDirect("not a url")).toBe(false);
  });

  it("hands opencode.ai straight to fetch, no dispatcher", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", body: "{}" },
      null
    );

    expect(await res.text()).toBe("DIRECT");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(calls[0].options.dispatcher).toBeUndefined();
  });

  it("control — any other host gets a proxy dispatcher", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://example.com/v1/x", { method: "POST", body: "{}" }, null).catch(() => {});

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].options.dispatcher).toBeDefined();
  });
});
