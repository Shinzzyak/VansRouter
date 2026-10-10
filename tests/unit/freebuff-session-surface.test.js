// Freebuff dashboard session surface (9router-go parity):
//   GET  /api/oauth/freebuff/session
//   POST /api/oauth/freebuff/session/switch
//
// The network is stubbed at proxyAwareFetch and the connection store at
// @/lib/db, so these exercise the real request shapes (headers, method, body)
// and the real status/refusal mapping — not a re-implementation of them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchMock, connStore } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  connStore: { list: [], byId: {} },
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

vi.mock("@/lib/db", () => ({
  getProviderConnections: vi.fn(async () => connStore.list),
  getProviderConnectionById: vi.fn(async (id) => connStore.byId[id] || null),
}));

import {
  readFreebuffSession,
  releaseFreebuffSession,
  switchFreebuffModel,
  clearFreebuffSessionsForToken,
  resetSessionCache,
  sessionStateSize,
} from "../../open-sse/executors/freebuff.js";
import {
  freebuffConnectionToken,
  freebuffSessionStatus,
  freebuffSessionSwitch,
} from "../../src/lib/oauth/freebuffSession.js";

const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";

function jsonResponse(data, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function calls() {
  return fetchMock.mock.calls.map(([url, options]) => ({ url, options }));
}

beforeEach(() => {
  fetchMock.mockReset();
  resetSessionCache();
  connStore.list = [];
  connStore.byId = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readFreebuffSession", () => {
  it("reads the seat and keeps only what an active session means", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      status: "active",
      currentModel: "z-ai/glm-5.3-flash",
      instanceId: "inst-1",
      expiresAt: "2026-10-10T16:00:00Z",
      accessTier: "free",
      rateLimit: { model: "z-ai/glm-5.3-flash", limit: 5, recentCount: 2 },
    }));

    const session = await readFreebuffSession("tok-1");

    expect(session.status).toBe("active");
    expect(session.currentModel).toBe("z-ai/glm-5.3-flash");
    expect(session.instanceId).toBe("inst-1");
    expect(session.rateLimit.recentCount).toBe(2);
    const [{ url, options }] = calls();
    expect(url).toBe(SESSION_URL);
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer tok-1");
  });

  it("drops the seat identity when the session has ended", async () => {
    // Upstream keeps the last model after the seat ends; echoing it would name a
    // model the account is no longer on.
    fetchMock.mockResolvedValue(jsonResponse({ status: "ended", currentModel: "z-ai/glm-5.2", instanceId: "inst-9" }));

    const session = await readFreebuffSession("tok-1");

    expect(session).toEqual({ status: "ended" });
  });

  it("separates banned from unauthorized and treats 404 as no seat", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "banned" }, { status: 403 }));
    expect(await readFreebuffSession("tok-1")).toEqual({ status: "banned" });

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    expect(await readFreebuffSession("tok-1")).toEqual({ status: "unauthorized" });

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    expect(await readFreebuffSession("tok-1")).toEqual({ status: "none" });
  });

  it("collapses an unknown upstream status to none", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "waiting_for_rain" }));
    expect(await readFreebuffSession("tok-1")).toEqual({ status: "none" });
  });
});

describe("releaseFreebuffSession", () => {
  it("deletes the seat with the instance header and reports the refund", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ended", freebucksRefund: 3 }));

    expect(await releaseFreebuffSession("tok-1", "inst-1")).toBe(3);

    const [{ url, options }] = calls();
    expect(url).toBe(SESSION_URL);
    expect(options.method).toBe("DELETE");
    expect(options.headers["x-freebuff-instance-id"]).toBe("inst-1");
  });

  it("treats an already-expired seat as released, and skips the call without an instance", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    expect(await releaseFreebuffSession("tok-1", "inst-1")).toBe(0);

    fetchMock.mockReset();
    expect(await releaseFreebuffSession("tok-1", "")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("switchFreebuffModel", () => {
  it("releases the held seat, clears the cache, then admits the new model", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "ended", freebucksRefund: 2 }))
      .mockResolvedValueOnce(jsonResponse({
        status: "active",
        instanceId: "inst-2",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }));

    const result = await switchFreebuffModel("tok-1", "deepseek/deepseek-v4-flash", { instanceId: "inst-1" });

    expect(result.model).toBe("deepseek/deepseek-v4-flash");
    expect(result.instanceId).toBe("inst-2");
    expect(result.freebucksRefund).toBe(2);
    expect(result.expiresAt).toBeTruthy();

    const [release, admit] = calls();
    expect(release.options.method).toBe("DELETE");
    expect(admit.options.method).toBe("POST");
    expect(admit.options.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    // The fresh seat is cached, so a chat request right after does not re-admit.
    expect(sessionStateSize().sessions).toBe(1);
  });

  it("refuses an empty model before touching the network", async () => {
    await expect(switchFreebuffModel("tok-1", "")).rejects.toThrow(/requires a model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clearFreebuffSessionsForToken drops only that token's rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "active", instanceId: "i", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await readFreebuffSession("tok-1");
    await switchFreebuffModel("tok-1", "z-ai/glm-5.3-flash", {});
    await switchFreebuffModel("tok-2", "z-ai/glm-5.3-flash", {});

    expect(sessionStateSize().sessions).toBe(2);
    clearFreebuffSessionsForToken("tok-1");
    expect(sessionStateSize().sessions).toBe(1);
  });
});

describe("freebuffSessionStatus / freebuffSessionSwitch (connection resolution)", () => {
  const conn = {
    id: "conn-1",
    provider: "freebuff",
    name: "fb-main",
    email: "fb@example.com",
    accessToken: "tok-1",
  };

  it("reads the token off the connection and carries the account in the reply", async () => {
    connStore.list = [conn];
    fetchMock.mockResolvedValue(jsonResponse({ status: "active", currentModel: "z-ai/glm-5.3-flash", instanceId: "inst-1" }));

    const status = await freebuffSessionStatus("");

    expect(status.connectionId).toBe("conn-1");
    expect(status.connectionName).toBe("fb-main");
    expect(status.currentModel).toBe("z-ai/glm-5.3-flash");
    expect(calls()[0].options.headers.Authorization).toBe("Bearer tok-1");
  });

  it("reports none without an upstream call when no account or token exists", async () => {
    expect(await freebuffSessionStatus("")).toEqual({ status: "none" });
    expect(fetchMock).not.toHaveBeenCalled();

    connStore.list = [{ id: "conn-2", provider: "freebuff" }];
    expect(await freebuffSessionStatus("")).toEqual({
      status: "none",
      connectionId: "conn-2",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not burn a seat when the account is already on the requested model", async () => {
    connStore.byId = { "conn-1": conn };
    fetchMock.mockResolvedValue(jsonResponse({
      status: "active",
      currentModel: "z-ai/glm-5.3-flash",
      instanceId: "inst-1",
      expiresAt: "2026-10-10T16:00:00Z",
    }));

    const result = await freebuffSessionSwitch({ connectionId: "conn-1", model: "z-ai/glm-5.3-flash" });

    expect(result.switched).toBe(false);
    expect(result.instanceId).toBe("inst-1");
    expect(calls()).toHaveLength(1);
    expect(calls()[0].options.method).toBe("GET");
  });

  it("returns the new seat with switched:true, and typed errors for bad input", async () => {
    connStore.byId = { "conn-1": conn };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "active", currentModel: "z-ai/glm-5.2", instanceId: "inst-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ended", freebucksRefund: 0 }))
      .mockResolvedValueOnce(jsonResponse({ status: "active", instanceId: "inst-7", expiresAt: "2026-10-10T17:00:00Z" }));

    const result = await freebuffSessionSwitch({ connectionId: "conn-1", model: "z-ai/glm-5.3-flash" });

    expect(result.switched).toBe(true);
    expect(result.currentModel).toBe("z-ai/glm-5.3-flash");
    expect(result.instanceId).toBe("inst-7");
    expect(result.freebucksRefund).toBeUndefined();

    expect(await freebuffSessionSwitch({ connectionId: "conn-1", model: "  " })).toEqual({ error: "missing model", status: 400 });
    expect(await freebuffSessionSwitch({ connectionId: "nope", model: "z-ai/glm-5.3-flash" })).toEqual({ error: "freebuff connection not found", status: 404 });
    expect(freebuffConnectionToken(null)).toBe("");
  });
});
