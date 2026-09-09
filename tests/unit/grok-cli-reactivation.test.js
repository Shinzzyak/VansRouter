import { describe, expect, it, vi } from "vitest";
import {
  backoffMsFromGrokExhaustedBody,
  isSuccessfulGrokReactivationProbe,
  runGrokCliReactivationTick,
} from "@/shared/services/grokCliReactivation.js";

const SIX_H = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

describe("backoffMsFromGrokExhaustedBody", () => {
  it("parses rolling 24h window with token overage", () => {
    const body = "Usage resets over a rolling 24-hour window — tokens (actual/limit): 2021622/2000000";
    const wait = backoffMsFromGrokExhaustedBody(body);
    expect(wait).toBeGreaterThanOrEqual(SIX_H);
    expect(wait).toBeLessThanOrEqual(TWENTY_FOUR_H);
  });

  it("2x overage → full 24h window cap", () => {
    const body = "rolling 24-hour window — tokens (actual/limit): 4000000/2000000";
    expect(backoffMsFromGrokExhaustedBody(body)).toBe(TWENTY_FOUR_H);
  });

  it("tiny overage → floor at 6h default backoff", () => {
    const body = "rolling 24-hour window — tokens (actual/limit): 2000001/2000000";
    expect(backoffMsFromGrokExhaustedBody(body)).toBe(SIX_H);
  });

  it("rolling-only body → half the window (≥ 6h, ≤ 24h)", () => {
    const body = "Usage resets over a rolling 24-hour window";
    const wait = backoffMsFromGrokExhaustedBody(body);
    expect(wait).toBe(12 * 60 * 60 * 1000);
  });

  it("unparseable → default 6h backoff", () => {
    expect(backoffMsFromGrokExhaustedBody("rate limited, try later")).toBe(SIX_H);
    expect(backoffMsFromGrokExhaustedBody("")).toBe(SIX_H);
  });

  it("accepts only an upstream success response", () => {
    expect(isSuccessfulGrokReactivationProbe({ ok: true, status: 200 }, "")).toBe(true);
    expect(isSuccessfulGrokReactivationProbe({ ok: true, status: 204 }, "")).toBe(true);
  });

  it("does not reactivate on a malformed-request 400", () => {
    expect(isSuccessfulGrokReactivationProbe(
      { ok: false, status: 400 },
      '{"error":"invalid request"}',
    )).toBe(false);
  });

  it("does not reactivate on quota or auth failures", () => {
    expect(isSuccessfulGrokReactivationProbe({ ok: false, status: 401 }, "")).toBe(false);
    expect(isSuccessfulGrokReactivationProbe({ ok: false, status: 429 }, "")).toBe(false);
  });

  it("does not reactivate a disabled account after a full tick returns 400", async () => {
    const updateProviderConnection = vi.fn();
    const executor = {
      execute: vi.fn().mockResolvedValue({
        response: {
          ok: false,
          status: 400,
          text: async () => '{"error":"invalid request"}',
        },
      }),
    };
    await runGrokCliReactivationTick({
      getProviderConnections: vi.fn().mockResolvedValue([{
        id: "conn-400",
        provider: "grok-cli",
        isActive: false,
        testStatus: "unavailable",
        lastError: "free-usage-exhausted",
        accessToken: "access",
        refreshToken: "refresh",
        providerSpecificData: {},
      }]),
      updateProviderConnection,
      getExecutor: vi.fn().mockReturnValue(executor),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshProviderCredentials: vi.fn().mockResolvedValue(null),
    }, true);

    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-400",
      expect.objectContaining({ testStatus: "error", errorCode: 400 }),
    );
    expect(updateProviderConnection).not.toHaveBeenCalledWith(
      "conn-400",
      expect.objectContaining({ isActive: true, testStatus: "active" }),
    );
  });
});
