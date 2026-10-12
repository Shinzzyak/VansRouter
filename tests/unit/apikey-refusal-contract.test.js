// The refusal a buyer reads, and the machine-readable code beside it.
//
// Two invariants that only a live run used to catch:
//  1. An API key bound to another address is refused with 403 — and the code has
//     to say so. The shared status map turns every 403 into "insufficient_quota",
//     so a client that branches on `code` was being told to top up a key that
//     was simply not allowed from where it was calling.
//  2. The diagnosis is best-effort. If the lookup behind it fails, the buyer
//     still gets a 401 with the three possible causes — never a 500, and never
//     a silent downgrade to anonymous access.

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ explain: null }));

vi.mock("@/sse/services/auth.js", () => ({
  explainApiKeyFailure: async (key) => h.explain(key),
  apiKeyFailureMessage: (failure) => `reason:${failure.reason}`,
}));

const { apiKeyRefusal } = await import("@/sse/services/apiKeyRefusal.js");
const { errorResponse, buildErrorBody } = await import("open-sse/utils/error.js");

describe("apiKeyRefusal", () => {
  it("refuses an address-bound key with 403 and says so in the code", async () => {
    h.explain = async () => ({ reason: "ip" });

    const refusal = await apiKeyRefusal("k", null);

    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe("api_key_ip");
    expect(refusal.message).toBe("reason:ip");
  });

  it("keeps the other causes at 401 with their own code", async () => {
    for (const reason of ["missing", "unknown", "disabled", "expired"]) {
      h.explain = async () => ({ reason });

      const refusal = await apiKeyRefusal("k", null);

      expect(refusal.status).toBe(401);
      expect(refusal.code).toBe(`api_key_${reason}`);
    }
  });

  it("survives a broken diagnosis without turning 401 into 500", async () => {
    h.explain = async () => {
      throw new Error("lookup down");
    };

    const refusal = await apiKeyRefusal("k", null);

    expect(refusal.status).toBe(401);
    expect(refusal.code).toBe("api_key_unknown");
    expect(refusal.message).toBe("Invalid, expired or disabled API key");
  });
});

describe("the error body code is overridable per call", () => {
  it("uses the override when one is given", async () => {
    const body = await errorResponse(403, "API key is not allowed from this IP address", "api_key_ip").json();

    expect(body.error.code).toBe("api_key_ip");
    expect(body.error.type).toBe("permission_error");
  });

  it("falls back to the status map, so quota 403s still read as quota", () => {
    expect(buildErrorBody(403, "quota").error.code).toBe("insufficient_quota");
    expect(buildErrorBody(401, "nope").error.code).toBe("invalid_api_key");
  });
});
