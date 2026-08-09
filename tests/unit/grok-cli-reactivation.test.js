import { describe, it, expect } from "vitest";
import { backoffMsFromGrokExhaustedBody } from "@/shared/services/grokCliReactivation.js";

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
});
