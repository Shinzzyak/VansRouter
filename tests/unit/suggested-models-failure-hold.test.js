import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ported from 9router-go CHANGELOG v1.9.17-exp.10 (Qoder catalog fix): "Failed
// catalog fetches for a credential with no live snapshot now hold non-forced
// fetches off for 30s, so an unreachable catalog no longer makes every request
// queue behind a fresh fetch and its timeout."
//
// Before the port this route had no cache at all: every dashboard render paid the
// full 5s AbortSignal timeout while upstream was down, because the client-side
// fetcher (src/shared/utils/providerModelsFetcher.js) only caches successes.

const URL_A = "https://example-a.test/v1/models";
const URL_B = "https://example-b.test/v1/models";

function req(url, extra = "") {
  // nvidia-free is one of the four registered FILTERS keys; the hold logic is
  // filter-agnostic, so any valid type exercises it.
  return { url: `https://router.test/api/providers/suggested-models?url=${encodeURIComponent(url)}&type=nvidia-free${extra}` };
}

async function loadRoute() {
  vi.resetModules();
  // assertPublicUrl does DNS resolution; stub it so the test stays offline.
  vi.doMock("../../src/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: async () => {} }));
  return await import("../../src/app/api/providers/suggested-models/route.js");
}

let fetchSpy;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/shared/utils/ssrfGuard.js");
  vi.resetModules();
});

describe("suggested-models failure hold", () => {
  it("holds repeat fetches for 30s after an upstream non-ok", async () => {
    const { GET } = await loadRoute();
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });

    const first = await GET(req(URL_A));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await GET(req(URL_A));
    expect(await second.json()).toEqual({ data: [], held: true });
    // The point of the port: no second upstream dial, so no second 5s timeout.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("holds after a network throw too", async () => {
    const { GET } = await loadRoute();
    fetchSpy.mockRejectedValue(new Error("ETIMEDOUT"));

    await GET(req(URL_A));
    const second = await GET(req(URL_A));
    expect(await second.json()).toEqual({ data: [], held: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("force=1 bypasses the hold (chat's last resort)", async () => {
    const { GET } = await loadRoute();
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });

    await GET(req(URL_A));
    await GET(req(URL_A, "&force=1"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a landed snapshot clears the hold", async () => {
    const { GET } = await loadRoute();
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });
    await GET(req(URL_A));

    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m:free" }] }) });
    const okRes = await GET(req(URL_A, "&force=1"));
    expect((await okRes.json()).held).toBeUndefined();

    // Hold cleared → the next non-forced call dials again rather than short-circuiting.
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });
    await GET(req(URL_A));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("holds per-url, not globally", async () => {
    const { GET } = await loadRoute();
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });

    await GET(req(URL_A));
    await GET(req(URL_B));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("still rejects an unknown filter type before any dial", async () => {
    const { GET } = await loadRoute();
    const res = await GET({ url: `https://router.test/x?url=${encodeURIComponent(URL_A)}&type=nope` });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});