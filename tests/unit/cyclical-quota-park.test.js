import { describe, it, expect } from "vitest";

import {
  CYCLICAL_QUOTA_PROVIDERS,
  isCyclicalQuotaExhausted,
  buildCyclicalQuotaExhaustedUpdate,
  getNextMonthReset,
  detectDailyQuotaExhaustion,
} from "../../open-sse/services/accountFallback.js";
import { CYCLICAL_PROVIDERS } from "../../src/sse/services/kimchiQuotaReactivation.js";

// The exact body CodeBuddy Intl returns once the monthly pack is spent. Captured
// from the live provider on 2026-10-22; the message is the only signal we get,
// there is no dedicated status code (it arrives inside a 429/4xx envelope).
const REAL_BODY = JSON.stringify({
  error: {
    data: {
      code: 14018,
      msg: "Credits exhausted. Please visit the link below to purchase add-on packs or subscribe to a plan to continue using the service.",
    },
  },
});

describe("isCyclicalQuotaExhausted", () => {
  it("matches the real CodeBuddy exhaustion body for every cyclical provider", () => {
    for (const provider of ["codebuddy-intl", "codebuddy-cn", "kimchi"]) {
      expect(isCyclicalQuotaExhausted(provider, REAL_BODY), provider).toBe(true);
    }
  });

  it("accepts the message as a plain string, not just JSON", () => {
    expect(isCyclicalQuotaExhausted("codebuddy-intl", "Credits exhausted.")).toBe(true);
  });

  it("ignores providers whose quota is a prepaid wallet", () => {
    expect(isCyclicalQuotaExhausted("gemini", REAL_BODY)).toBe(false);
    expect(isCyclicalQuotaExhausted("openai", REAL_BODY)).toBe(false);
  });

  it("ignores ordinary rate limiting on a cyclical provider", () => {
    expect(isCyclicalQuotaExhausted("codebuddy-intl", '{"error":{"msg":"rate limit exceeded"}}')).toBe(false);
    expect(isCyclicalQuotaExhausted("codebuddy-intl", '{"error":{"msg":"exhausted all retries"}}')).toBe(false);
  });

  it("is false for empty input", () => {
    expect(isCyclicalQuotaExhausted("codebuddy-intl", "")).toBe(false);
    expect(isCyclicalQuotaExhausted("codebuddy-intl", null)).toBe(false);
  });
});

describe("buildCyclicalQuotaExhaustedUpdate", () => {
  const now = new Date("2026-10-22T07:00:00.000Z");

  it("parks a CodeBuddy account until the 1st of next month, in UTC", () => {
    const update = buildCyclicalQuotaExhaustedUpdate("codebuddy-intl", now);
    expect(update.isActive).toBe(false);
    expect(update.testStatus).toBe("quota_exhausted");
    expect(update.rateLimitedUntil).toBe("2026-11-01T00:00:00.000Z");
    expect(update.quotaResetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(update.quotaExhaustedAt).toBe(now.toISOString());
  });

  it("overwrites the stored reason so the dashboard stops reporting a broken key", () => {
    const update = buildCyclicalQuotaExhaustedUpdate("codebuddy-intl", now);
    expect(update.lastError).toContain("Credits exhausted");
    expect(update.lastError).toContain("2026-11-01T00:00:00.000Z");
    expect(update.lastError).not.toMatch(/invalid api key/i);
  });

  it("keeps Kimchi on its historical next-day reset", () => {
    const update = buildCyclicalQuotaExhaustedUpdate("kimchi", now);
    expect(update.rateLimitedUntil).toBe("2026-10-23T00:00:00.000Z");
  });

  it("rolls the year over in December", () => {
    expect(getNextMonthReset(new Date("2026-12-15T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("daily-quota detector stays out of the way", () => {
  it("does not claim a monthly-refill provider for the model-level lock", () => {
    // The daily detector locks a MODEL until tomorrow. A monthly pack is a
    // different condition with a different reset, and letting both fire means the
    // model is locked to a date that has nothing to do with the cycle.
    expect(detectDailyQuotaExhaustion("codebuddy-intl", "daily quota exceeded")).toBeNull();
    expect(detectDailyQuotaExhaustion("codebuddy-cn", "daily quota exceeded")).toBeNull();
    expect(detectDailyQuotaExhaustion("kimchi", "daily quota exceeded")).toBeNull();
  });
});

describe("provider list parity", () => {
  it("the sweep's duplicated list matches the canonical set", () => {
    // Two copies exist on purpose: the sweep must not import accountFallback
    // (it drags circuitBreaker into the Next instrumentation build). This test is
    // the only thing keeping them honest.
    expect([...CYCLICAL_QUOTA_PROVIDERS].sort()).toEqual([...CYCLICAL_PROVIDERS].sort());
  });
});
