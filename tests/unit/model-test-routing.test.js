import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("model test route kind routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: "abc" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes image model tests to /api/v1/images/generations", async () => {
    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hf/black-forest-labs/FLUX.1-schnell",
        kind: "image",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/images/generations"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "hf/black-forest-labs/FLUX.1-schnell",
          prompt: "test",
        }),
      })
    );
  });
});
