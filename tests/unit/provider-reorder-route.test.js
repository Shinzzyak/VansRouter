// Route contract for the two pool-move endpoints (9router-go parity:
// `HandleReorderConnection` is registered on both /api/connections/{id}/reorder
// and /api/providers/{id}/reorder).
//
// What is pinned here:
//   * `direction` is validated — a typo'd direction is a 400, not a silent
//     200 that leaves the UI looking broken.
//   * an unknown connection is a 404.
//   * the move is delegated to the transactional pool reorder (swap +
//     renumber), NOT to a per-row priority PUT. A per-row PUT cannot swap
//     atomically: the moved row takes the newest updatedAt, the tie-break puts
//     it first, and "move down" silently becomes "move up".

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  connection: { id: "c2", provider: "za", priority: 2 },
  reorder: vi.fn(async () => ({ order: ["c1", "c2"] })),
  update: vi.fn(async () => ({})),
  connections: [{ id: "c1", provider: "za", priority: 1 }],
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: async () => h.connection,
  getProviderConnections: async () => h.connections,
  reorderProviderConnections: (...a) => h.reorder(...a),
  updateProviderConnection: (...a) => h.update(...a),
}));

vi.mock("@/lib/auth/routeAuth.js", () => ({
  requireDashboardAuth: async () => h.authed,
}));

const post = (body) =>
  new Request("http://localhost/api/providers/c2/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = { params: Promise.resolve({ id: "c2" }) };

beforeEach(() => {
  h.authed = true;
  h.connection = { id: "c2", provider: "za", priority: 2 };
  h.reorder.mockClear();
  h.update.mockClear();
});

describe("POST /api/providers/{id}/reorder", () => {
  it("rejects a missing or unknown direction with 400 and does not move anything", async () => {
    const { POST } = await import("@/app/api/providers/[id]/reorder/route.js");
    for (const body of [{}, { direction: "sideways" }, { direction: "" }, { direction: 1 }]) {
      const res = await POST(post(body), params);
      expect(res.status).toBe(400);
    }
    expect(h.reorder).not.toHaveBeenCalled();
  });

  it("404s when the connection does not exist", async () => {
    h.connection = null;
    const { POST } = await import("@/app/api/providers/[id]/reorder/route.js");
    const res = await POST(post({ direction: "up" }), params);
    expect(res.status).toBe(404);
    expect(h.reorder).not.toHaveBeenCalled();
  });

  it("moves up and down through the transactional pool reorder", async () => {
    const { POST } = await import("@/app/api/providers/[id]/reorder/route.js");
    expect((await POST(post({ direction: "up" }), params)).status).toBe(200);
    expect(h.reorder).toHaveBeenLastCalledWith("za", "c2", -1);
    expect((await POST(post({ direction: "down" }), params)).status).toBe(200);
    expect(h.reorder).toHaveBeenLastCalledWith("za", "c2", 1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("404s when the repo reports the row is not in the pool", async () => {
    h.reorder.mockResolvedValueOnce({ error: "not_found" });
    const { POST } = await import("@/app/api/providers/[id]/reorder/route.js");
    const res = await POST(post({ direction: "up" }), params);
    expect(res.status).toBe(404);
  });

  it("returns a Response, never a bare boolean, when unauthenticated", async () => {
    h.authed = false;
    const { POST } = await import("@/app/api/providers/[id]/reorder/route.js");
    const res = await POST(post({ direction: "up" }), params);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/connections/{id}/reorder", () => {
  it("delegates direction to the transactional pool reorder", async () => {
    const { POST } = await import("@/app/api/connections/[id]/reorder/route.js");
    const res = await POST(post({ direction: "down" }), params);
    expect(res.status).toBe(200);
    expect(h.reorder).toHaveBeenLastCalledWith("za", "c2", 1);
    expect(h.update).not.toHaveBeenCalled();
  });
});
