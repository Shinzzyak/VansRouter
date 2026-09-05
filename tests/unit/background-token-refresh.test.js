import { describe, expect, it } from "vitest";
import { selectConnectionsNeedingRefresh } from "../../src/sse/services/backgroundTokenRefresh.js";

describe("background OAuth token refresh selection", () => {
  it("selects near-expiry Antigravity OAuth connections with refresh tokens", () => {
    const now = Date.parse("2026-09-06T00:00:00.000Z");
    const due = selectConnectionsNeedingRefresh([
      {
        id: "ag-due",
        provider: "antigravity",
        authType: "oauth",
        refreshToken: "refresh",
        expiresAt: "2026-09-06T00:20:00.000Z",
      },
      {
        id: "ag-later",
        provider: "antigravity",
        authType: "oauth",
        refreshToken: "refresh",
        expiresAt: "2026-09-06T02:00:00.000Z",
      },
      {
        id: "ag-no-refresh",
        provider: "antigravity",
        authType: "oauth",
        expiresAt: "2026-09-06T00:20:00.000Z",
      },
    ], now);

    expect(due.map((connection) => connection.id)).toEqual(["ag-due"]);
  });

  it("skips blocked refresh tokens and non-OAuth connections", () => {
    const now = Date.parse("2026-09-06T00:00:00.000Z");
    const due = selectConnectionsNeedingRefresh([
      {
        id: "blocked",
        provider: "antigravity",
        authType: "oauth",
        refreshToken: "refresh",
        expiresAt: "2026-09-06T00:01:00.000Z",
        providerSpecificData: { refreshBlocked: "invalid_grant" },
      },
      {
        id: "apikey",
        provider: "antigravity",
        authType: "apikey",
        refreshToken: "refresh",
        expiresAt: "2026-09-06T00:01:00.000Z",
      },
    ], now);

    expect(due).toEqual([]);
  });
});
