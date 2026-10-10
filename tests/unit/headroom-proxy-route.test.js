// Headroom proxy route: upstream failures must not look like handler bugs.
//
// The handler used to answer 500 for any thrown error, so an unreachable
// Headroom (its port is not always up on the VPS) reported "our route is
// broken". 502 is the correct signal: the gateway could not reach its upstream.
// A genuine upstream response must still pass through untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getSettings } = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("@/lib/localDb", () => ({ getSettings }));

import { GET } from "@/app/api/headroom/proxy/[...path]/route.js";

function ctx(path = []) {
  return { params: Promise.resolve({ path }) };
}

beforeEach(() => {
  getSettings.mockReset();
  getSettings.mockResolvedValue({ headroomUrl: "http://127.0.0.1:8788" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/headroom/proxy", () => {
  it("502s when the upstream refuses the connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const res = await GET(new Request("http://x/api/headroom/proxy/stats"), ctx(["stats"]));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Headroom upstream unreachable");
    expect(body.detail).toContain("fetch failed");
  });

  it("502s when the configured Headroom URL is unusable", async () => {
    getSettings.mockResolvedValue({ headroomUrl: "ftp://nope" });

    const res = await GET(new Request("http://x/api/headroom/proxy/stats"), ctx(["stats"]));

    expect(res.status).toBe(502);
  });

  it("passes a real upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ total_saved: 42 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const res = await GET(new Request("http://x/api/headroom/proxy/stats"), ctx(["stats"]));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ total_saved: 42 });
  });

  it("forwards an upstream error status instead of masking it as 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    const res = await GET(new Request("http://x/api/headroom/proxy/stats"), ctx(["stats"]));

    expect(res.status).toBe(503);
  });

  it("strips viewer credentials when the upstream is not loopback", async () => {
    let seen = null;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      seen = init.headers;
      return new Response("{}", { status: 200 });
    }));
    getSettings.mockResolvedValue({ headroomUrl: "https://headroom.example.com" });

    await GET(new Request("http://x/api/headroom/proxy/stats", {
      headers: { cookie: "auth_token=secret", authorization: "Bearer secret" },
    }), ctx(["stats"]));

    expect(seen.get("cookie")).toBeNull();
    expect(seen.get("authorization")).toBeNull();
  });
});
