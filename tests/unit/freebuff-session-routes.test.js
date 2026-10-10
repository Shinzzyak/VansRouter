// Route-level parity for the Freebuff dashboard session surface and the bare
// Headroom proxy alias: URL shape + auth gate + envelope, with the session
// implementation mocked (its own behaviour is covered in
// freebuff-session-surface.test.js).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sessionStatus, sessionSwitch, auth } = vi.hoisted(() => ({
  sessionStatus: vi.fn(),
  sessionSwitch: vi.fn(),
  auth: vi.fn(async () => true),
}));

vi.mock("@/lib/oauth/freebuffSession.js", () => ({
  freebuffSessionStatus: sessionStatus,
  freebuffSessionSwitch: sessionSwitch,
}));
vi.mock("@/lib/auth/routeAuth.js", () => ({ requireDashboardAuth: auth }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(true);
});

describe("GET /api/oauth/freebuff/session", () => {
  it("passes connectionId through and returns the session envelope", async () => {
    sessionStatus.mockResolvedValue({ status: "active", connectionId: "c1", currentModel: "z-ai/glm-5.3-flash" });
    const { GET } = await import("@/app/api/oauth/freebuff/session/route.js");

    const res = await GET(new Request("http://x/api/oauth/freebuff/session?connectionId=c1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "active",
      connectionId: "c1",
      currentModel: "z-ai/glm-5.3-flash",
    });
    expect(sessionStatus).toHaveBeenCalledWith("c1");
  });

  it("401s without dashboard auth and never reads the session", async () => {
    auth.mockResolvedValue(false);
    const { GET } = await import("@/app/api/oauth/freebuff/session/route.js");

    const res = await GET(new Request("http://x/api/oauth/freebuff/session"));

    expect(res.status).toBe(401);
    expect(sessionStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/oauth/freebuff/session/switch", () => {
  it("accepts both connectionId spellings and returns the switch result", async () => {
    sessionSwitch.mockResolvedValue({ status: "active", currentModel: "z-ai/glm-5.2", switched: true });
    const { POST } = await import("@/app/api/oauth/freebuff/session/switch/route.js");

    const res = await POST(new Request("http://x/api/oauth/freebuff/session/switch", {
      method: "POST",
      body: JSON.stringify({ connection_id: "c1", model: "z-ai/glm-5.2" }),
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ switched: true });
    expect(sessionSwitch).toHaveBeenCalledWith({ connectionId: "c1", model: "z-ai/glm-5.2" });
  });

  it("maps a typed failure to its status code", async () => {
    sessionSwitch.mockResolvedValue({ error: "missing model", status: 400 });
    const { POST } = await import("@/app/api/oauth/freebuff/session/switch/route.js");

    const res = await POST(new Request("http://x/api/oauth/freebuff/session/switch", {
      method: "POST",
      body: JSON.stringify({ connectionId: "c1" }),
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing model" });
  });
});

describe("bare /api/headroom/proxy", () => {
  it("re-exports the same handlers as the wildcard route", async () => {
    const bare = await import("@/app/api/headroom/proxy/route.js");
    const wildcard = await import("@/app/api/headroom/proxy/[...path]/route.js");

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(bare[method]).toBe(wildcard[method]);
    }
  });
});
