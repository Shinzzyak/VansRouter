import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — request-scoped 4xx", () => {
  it("400 validasi: bukan salah kredensial, tapi request-scoped", () => {
    const r = checkFallbackError(400, "invalid parameter: temperature must be <= 2", 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.requestScoped).toBe(true);
  });

  it("400 context overflow juga request-scoped", () => {
    const r = checkFallbackError(413, "prompt is too long: 250000 tokens > 200000 maximum", 0);
    expect(r.requestScoped).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("422 unsupported parameter: request-scoped", () => {
    expect(checkFallbackError(422, "unsupported field", 0).requestScoped).toBe(true);
  });

  it("kredensial tetap account-scoped: 401/402/403/429 tidak jadi requestScoped", () => {
    for (const status of [401, 402, 403, 429]) {
      const r = checkFallbackError(status, "upstream says no", 0);
      expect(r.requestScoped).toBeUndefined();
      expect(r.shouldFallback).toBe(true);
    }
  });

  it("kredit habis tetap account-scoped walau statusnya 400", () => {
    const r = checkFallbackError(400, "Your credit balance is too low to access the API", 0);
    expect(r.requestScoped).toBeUndefined();
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
  });

  it("insufficient credits juga account-scoped", () => {
    const r = checkFallbackError(400, "Insufficient credits to run this model", 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.requestScoped).toBeUndefined();
  });

  it("5xx tetap tidak request-scoped", () => {
    const r = checkFallbackError(503, "overloaded", 0);
    expect(r.requestScoped).toBeUndefined();
    expect(r.shouldFallback).toBe(true);
  });
});
