// The probe route is what turns a measurement into a stored field.
//
// The repo round trip is pinned separately (proxy-pool-probe-fields.test.js);
// this pins the half before it — that the handler forwards what it measured.
// A route that probes, reports the latency in its own response, and then forgets
// to persist it looks completely healthy from the outside: the button spins, the
// number flashes, and the list stays empty forever.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { auth, getPool, updatePool, testProxy } = vi.hoisted(() => ({
  auth: vi.fn(),
  getPool: vi.fn(),
  updatePool: vi.fn(),
  testProxy: vi.fn(),
}));

vi.mock("@/lib/auth/routeAuth.js", () => ({ requireDashboardAuth: auth }));
vi.mock("@/models", () => ({ getProxyPoolById: getPool, updateProxyPool: updatePool }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: testProxy }));

import { POST } from "@/app/api/proxy-pools/[id]/test/route.js";

function call(id = "p1") {
  const request = new Request(`http://localhost/api/proxy-pools/${id}/test`, { method: "POST" });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(true);
  getPool.mockResolvedValue({ id: "p1", proxyUrl: "http://127.0.0.1:1/", type: "http" });
  updatePool.mockResolvedValue({});
});

describe("proxy pool probe persists what it measured", () => {
  it("stores the measured round trip as latency", async () => {
    testProxy.mockResolvedValue({ ok: true, status: 200, statusText: "OK", elapsedMs: 412 });

    const res = await call();

    expect(res.status).toBe(200);
    const [, patch] = updatePool.mock.calls[0];
    expect(patch.latency).toBe(412);
    expect(patch.testStatus).toBe("active");
    expect(patch.lastTestedAt).toBeTruthy();
    expect(patch.lastError).toBeNull();
  });

  it("a failed probe stores latency 0 instead of leaving the field out", async () => {
    testProxy.mockResolvedValue({ ok: false, status: 500, error: "connect ECONNREFUSED 127.0.0.1:1" });

    await call();

    const [, patch] = updatePool.mock.calls[0];
    // 0 = "probed, nothing measured". Omitting the key would make the row
    // indistinguishable from one that was never probed at all.
    expect(patch.latency).toBe(0);
    expect(patch.testStatus).toBe("error");
    expect(patch.lastError).toMatch(/ECONNREFUSED/);
    expect(patch.isActive).toBe(false);
  });

  it("a success with no timing still stores a number, never undefined", async () => {
    testProxy.mockResolvedValue({ ok: true, status: 200 });

    await call();

    const [, patch] = updatePool.mock.calls[0];
    expect(typeof patch.latency).toBe("number");
    expect(patch.latency).toBe(0);
  });

  it("refuses an unauthenticated probe and writes nothing", async () => {
    auth.mockResolvedValue(false);

    const res = await call();

    expect(res.status).toBe(401);
    expect(updatePool).not.toHaveBeenCalled();
  });

  it("404s an unknown pool without writing", async () => {
    getPool.mockResolvedValue(null);

    const res = await call("nope");

    expect(res.status).toBe(404);
    expect(updatePool).not.toHaveBeenCalled();
  });
});
