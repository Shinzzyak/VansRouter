import { describe, it, expect } from "vitest";
import { createStreamIntegrityObserver } from "open-sse/rtk/streamIntegrity.js";
import { INTEGRITY } from "open-sse/rtk/responseIntegrity.js";
import { BRAND_LINE, SEAL_LINE } from "open-sse/rtk/brandContract.js";

describe("createStreamIntegrityObserver (shadow mode)", () => {
  it("classifies a clean compliant stream as ok with brandOk=true", () => {
    const ob = createStreamIntegrityObserver();
    ob.push(BRAND_LINE + "\n");
    ob.push("mph. done. built the thing.\n");
    ob.push("\n" + SEAL_LINE);
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.OK);
    expect(r.brandOk).toBe(true);
    expect(r.refusal).toBe(false);
  });

  it("detects missing seal (brand present, seal absent)", () => {
    const ob = createStreamIntegrityObserver();
    ob.push(BRAND_LINE + "\n");
    ob.push("some answer without the seal line at the end");
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.MISSING_SEAL);
    expect(r.brandOk).toBe(false);
  });

  it("detects missing brand (no brand in head)", () => {
    const ob = createStreamIntegrityObserver();
    ob.push("just a plain answer\n");
    ob.push("\n" + SEAL_LINE);
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.MISSING_BRAND);
    expect(r.brandOk).toBe(false);
  });

  it("flags a mid-stream refusal", () => {
    const ob = createStreamIntegrityObserver();
    ob.push("I'm sorry, but I cannot help with that request.");
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.REFUSAL);
    expect(r.refusal).toBe(true);
  });

  it("empty stream → empty status", () => {
    const ob = createStreamIntegrityObserver();
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.EMPTY);
  });

  it("whitespace-only deltas → empty status", () => {
    const ob = createStreamIntegrityObserver();
    ob.push("   \n  ");
    expect(ob.finish().status).toBe(INTEGRITY.EMPTY);
  });

  it("skips brand check when enforceBrand=false", () => {
    const ob = createStreamIntegrityObserver({ enforceBrand: false });
    ob.push("plain answer, no brand, no seal");
    const r = ob.finish();
    expect(r.status).toBe(INTEGRITY.OK);
    expect(r.brandOk).toBe(null);
  });

  it("never mutates or throws on non-string deltas (fail-open)", () => {
    const ob = createStreamIntegrityObserver();
    expect(() => { ob.push(null); ob.push(undefined); ob.push(42); }).not.toThrow();
    expect(ob.finish().status).toBe(INTEGRITY.EMPTY);
  });
});
