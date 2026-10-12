// The two crossings between the seller's editor (strings, "" = unlimited) and
// the API (integers or null). Pure functions, so they are tested pure: no
// browser, no database, no fetch.
import { describe, it, expect } from "vitest";
import {
  QUOTA_FIELDS,
  emptyQuota,
  quotaFromKey,
  parseQuota,
  sanitizeQuotaLimits,
  hasQuota,
  quotaSummary,
} from "@/shared/utils/keyQuota";

const QUOTA_KEYS = QUOTA_FIELDS.map((f) => f.key);

describe("quota editor state", () => {
  it("starts every axis blank, which reads as unlimited", () => {
    const state = emptyQuota();
    expect(Object.keys(state).sort()).toEqual([...QUOTA_KEYS].sort());
    expect(Object.values(state).every((v) => v === "")).toBe(true);
    expect(parseQuota(state).set).toBe(0);
    expect(Object.values(parseQuota(state).limits).every((v) => v === null)).toBe(true);
  });

  it("renders an existing record as strings and null as blank", () => {
    const state = quotaFromKey({ rpm: 60, tokenBalance: 0, rateLimitTpm: null });
    expect(state.rpm).toBe("60");
    // A zero balance is a real value: a spent key must not look unlimited.
    expect(state.tokenBalance).toBe("0");
    expect(state.rateLimitTpm).toBe("");
    expect(state.tokensMonthly).toBe("");
  });

  it("survives an empty or missing record", () => {
    expect(quotaFromKey()).toEqual(emptyQuota());
    expect(quotaFromKey({})).toEqual(emptyQuota());
  });
});

describe("parseQuota — editor state to API limits", () => {
  it("maps blank to null and keeps the count of axes actually set", () => {
    const { limits, set } = parseQuota({ rpm: "60", rateLimitTpm: " 20000 ", tokens5h: "" });
    expect(limits.rpm).toBe(60);
    expect(limits.rateLimitTpm).toBe(20_000);
    expect(limits.tokens5h).toBeNull();
    expect(set).toBe(2);
  });

  it("treats junk and negatives as unlimited rather than as a tiny limit", () => {
    const { limits, set } = parseQuota({ rpm: "abc", rph: "-5", rpd: "NaN", maxTokens: "1e3" });
    expect(limits.rpm).toBeNull();
    expect(limits.rph).toBeNull();
    expect(limits.rpd).toBeNull();
    // "1e3" is a finite number, so it is a real limit, floored.
    expect(limits.maxTokens).toBe(1000);
    expect(set).toBe(1);
  });

  it("floors fractions: a limit of 0.5 requests per minute is not a thing", () => {
    expect(parseQuota({ rpm: "2.9" }).limits.rpm).toBe(2);
  });

  it("accepts a real zero — that is a closed door, not an open one", () => {
    const { limits, set } = parseQuota({ rpm: 0 });
    expect(limits.rpm).toBe(0);
    expect(set).toBe(1);
  });

  it("names every axis, so an unknown field never becomes a limit", () => {
    expect(Object.keys(parseQuota({ nonsense: "5" }).limits).sort()).toEqual([...QUOTA_KEYS].sort());
  });
});

describe("sanitizeQuotaLimits — the server's trust boundary", () => {
  it("passes null and undefined through as 'no limits'", () => {
    for (const input of [null, undefined]) {
      const out = sanitizeQuotaLimits(input);
      expect(out.ok).toBe(true);
      expect(out.set).toBe(0);
    }
  });

  it("refuses a non-object rather than coercing it", () => {
    for (const input of ["rpm=60", 42, ["rpm"], true]) {
      const out = sanitizeQuotaLimits(input);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/limits must be an object/);
    }
  });

  it("drops unknown axes instead of writing a column that does not exist", () => {
    const out = sanitizeQuotaLimits({ rpm: 60, isAdmin: true, __proto__: { polluted: 1 } });
    expect(out.ok).toBe(true);
    expect(out.limits.rpm).toBe(60);
    expect(Object.keys(out.limits).sort()).toEqual([...QUOTA_KEYS, "allowedIps"].sort());
    expect(out.limits).not.toHaveProperty("isAdmin");
    expect({}.polluted).toBeUndefined();
  });

  it("keeps a valid IP allow-list and counts it as something carried", () => {
    const out = sanitizeQuotaLimits({ allowedIps: ["203.0.113.7", " 198.51.100.0/24 "] });
    expect(out.ok).toBe(true);
    expect(out.limits.allowedIps).toEqual(["203.0.113.7", "198.51.100.0/24"]);
    expect(out.set).toBe(1);
  });

  it("refuses a malformed IP list rather than silently opening the key", () => {
    for (const bad of ["203.0.113.7", [""], ["ok", 5], [null]]) {
      const out = sanitizeQuotaLimits({ tokenBalance: 100, allowedIps: bad });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/allowedIps/);
    }
  });

  it("carries personaInject only when it is explicitly false", () => {
    expect(sanitizeQuotaLimits({ personaInject: false }).limits.personaInject).toBe(false);
    expect(sanitizeQuotaLimits({ personaInject: true }).limits.personaInject).toBeUndefined();
  });
});

describe("hasQuota — the 'not an empty code' check", () => {
  it("is false for nothing, null, or an all-null blob", () => {
    expect(hasQuota(null)).toBe(false);
    expect(hasQuota(undefined)).toBe(false);
    expect(hasQuota({ rpm: null, tokenBalance: null })).toBe(false);
    expect(hasQuota({ allowedIps: [] })).toBe(false);
  });

  it("is true for any real axis, including a zero balance", () => {
    expect(hasQuota({ rpm: 60 })).toBe(true);
    expect(hasQuota({ tokenBalance: 0 })).toBe(true);
    expect(hasQuota({ allowedIps: ["203.0.113.7"] })).toBe(true);
    expect(hasQuota({ personaInject: false })).toBe(true);
  });
});

describe("quotaSummary — what the seller reads at a glance", () => {
  it("omits unlimited axes and returns nothing when nothing is set", () => {
    expect(quotaSummary({})).toBe("");
    expect(quotaSummary({ rpm: null, rateLimitTpm: null })).toBe("");
  });

  it("shortens token counts and keeps the axes in a stable order", () => {
    expect(quotaSummary({ tokenBalance: 5_000_000, rateLimitTpm: 20_000, rpm: 60 })).toBe(
      "5jt token · 20k TPM · 60/menit"
    );
    expect(quotaSummary({ rateLimitTpm: 1_500 })).toBe("1.5k TPM");
  });

  it("reads a zero balance out loud instead of hiding it", () => {
    expect(quotaSummary({ tokenBalance: 0 })).toBe("0 token");
  });
});
