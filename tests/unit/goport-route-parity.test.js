// Parity guards for the three route surfaces the Go port (`go-port`) exposes
// that our Next router lacked. They are aliases, not new behaviour: each one
// delegates to the same repo function as its primary sibling and only differs
// in URL shape / response envelope. The test pins the envelope so a future
// refactor of the primary route cannot silently change the alias contract.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getRequestDetailById = vi.fn();
const getRequestDetails = vi.fn();
const deleteModelAlias = vi.fn();
const invalidateAllowedModelsCache = vi.fn();
const clearCachedProviderModels = vi.fn(() => Promise.resolve());

vi.mock("@/lib/usageDb.js", () => ({ getRequestDetailById, getRequestDetails }));
vi.mock("@/lib/usageDb", () => ({ getRequestDetailById, getRequestDetails }));
vi.mock("@/models", () => ({ deleteModelAlias }));
vi.mock("@/sse/services/allowedModels.js", () => ({ invalidateAllowedModelsCache }));
vi.mock("@/lib/db/repos/cachedModelsRepo.js", () => ({ clearCachedProviderModels }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/usage/detail (go-port parity)", () => {
  it("returns the bare detail object for a known id", async () => {
    getRequestDetailById.mockResolvedValue({ id: "r1", provider: "bansos" });
    const { POST } = await import("@/app/api/usage/detail/route.js");
    const res = await POST(new Request("http://x/api/usage/detail", {
      method: "POST",
      body: JSON.stringify({ id: "r1" }),
    }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "r1", provider: "bansos" });
    expect(getRequestDetailById).toHaveBeenCalledWith("r1");
  });

  it("400s on invalid JSON and on a missing id", async () => {
    const { POST } = await import("@/app/api/usage/detail/route.js");
    const bad = await POST(new Request("http://x/api/usage/detail", { method: "POST", body: "{" }));
    expect(bad.status).toBe(400);

    const noId = await POST(new Request("http://x/api/usage/detail", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    expect(noId.status).toBe(400);
    expect(getRequestDetailById).not.toHaveBeenCalled();
  });

  it("404s when the row is gone", async () => {
    getRequestDetailById.mockResolvedValue(null);
    const { POST } = await import("@/app/api/usage/detail/route.js");
    const res = await POST(new Request("http://x/api/usage/detail", {
      method: "POST",
      body: JSON.stringify({ id: "missing" }),
    }));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/usage/details (go-port parity)", () => {
  it("wraps the list as { details, pagination: { totalItems } } and redacts payloads", async () => {
    getRequestDetails.mockResolvedValue({
      details: [{ id: "r1", providerRequest: { huge: "blob" } }],
      pagination: { page: 1, pageSize: 20, totalItems: 7 },
    });
    const { GET } = await import("@/app/api/usage/details/route.js");
    const res = await GET(new Request("http://x/api/usage/details?page=1&pageSize=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toEqual({ totalItems: 7 });
    expect(body.details[0].providerRequest).toEqual({ redacted: true });
    expect(getRequestDetails).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it("rejects an out-of-range pageSize", async () => {
    const { GET } = await import("@/app/api/usage/details/route.js");
    const res = await GET(new Request("http://x/api/usage/details?pageSize=500"));
    expect(res.status).toBe(400);
    expect(getRequestDetails).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/models/alias/[alias] (go-port parity)", () => {
  it("deletes by path segment and drops the model caches", async () => {
    const { DELETE } = await import("@/app/api/models/alias/[alias]/route.js");
    const res = await DELETE(new Request("http://x/api/models/alias/myalias", { method: "DELETE" }), {
      params: Promise.resolve({ alias: "myalias" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(deleteModelAlias).toHaveBeenCalledWith("myalias");
    expect(invalidateAllowedModelsCache).toHaveBeenCalled();
  });
});
