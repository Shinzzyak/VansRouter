// Guard for the per-key governance invariants that only bite on a LIVE router.
//
//  1. A supplied key selects policy even when settings.requireApiKey is false
//     (local mode). Dispatch already resolves the key in that case, so a listing
//     that skipped the allowlist let a key SEE models it could not CALL — the
//     exact inverse of the F-7 invariant. Caught by the deployed e2e run (an
//     allowlisted key got n=1007 models), not by any unit test.
//  2. GET /api/keys hands the dashboard the plaintext key on purpose (the key
//     selector and the endpoint page copy it), so the safety property is not
//     "never returns a key" — it is "only an authenticated operator can read
//     it". That gate lives in dashboardGuard; this test pins it so a future
//     refactor cannot quietly make the key list public.
//
// The masking itself is asserted here too, because `keyDisplay` is the field a
// row renders and a short key must collapse to "***" rather than leak entropy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => {
  const state = {
    settings: { requireApiKey: false },
    keys: [],
    models: [],
    allowlistCalls: [],
  };
  const matches = (id, info) => {
    state.allowlistCalls.push([id, info?.allowedModels ?? null]);
    const patterns = info?.allowedModels;
    if (!Array.isArray(patterns) || patterns.length === 0) return true;
    const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    return patterns.includes(id) || patterns.includes(bare);
  };
  return { state, matches };
});

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => h.state.settings,
  getApiKeys: async () => h.state.keys,
  getApiKeyUsageSnapshot: () => ({ requests: 0 }),
}));

vi.mock("@/sse/services/allowedModels.js", () => ({
  buildModelsList: async () => h.state.models,
  matchesModelAllowlist: (id, info) => h.matches(id, info),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => {
    const raw = request?.headers?.get("authorization") || "";
    return raw.startsWith("Bearer ") ? raw.slice(7) : null;
  },
  isValidApiKey: async (token) =>
    token === "k-allow" ? { id: "key-1", allowedModels: ["za/glm-5.3-flash"] } : null,
  isProviderAllowed: async () => true,
  isComboAllowed: () => true,
  isKindAllowed: () => true,
}));

vi.mock("@/lib/db/repos/apiKeyUsageRepo.js", () => ({
  checkApiKeyLimits: () => ({ allowed: true }),
  recordApiKeyUsage: () => {},
}));

vi.mock("open-sse/services/combo.js", () => ({ stripComboPrefix: (s) => s }));
vi.mock("open-sse/providers/capabilities.js", () => ({ capabilitiesFromServiceKind: () => [] }));
vi.mock("@/lib/modelLookup.js", () => ({
  lookupModel: async () => ({ status: 200, body: { ok: true } }),
}));

const keysRoute = await import("@/app/api/keys/route.js");
const modelsRoute = await import("@/app/api/v1/models/route.js");
const kindRoute = await import("@/app/api/models/[kind]/[[...path]]/route.js");
const { maskApiKey, MASKED_UNKNOWN } = await import("@/lib/db/helpers/apiKeyMask.js");

const req = (token) =>
  new Request("http://local/api", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  h.state.settings = { requireApiKey: false };
  h.state.keys = [];
  h.state.models = [];
  h.state.allowlistCalls = [];
});

describe("listing honours a supplied key in local mode (requireApiKey=false)", () => {
  const catalog = [
    { id: "za/glm-5.3-flash", owned_by: "za", kind: "llm" },
    { id: "za/gpt-5", owned_by: "za", kind: "llm" },
    { id: "combo/smart-fallback", owned_by: "combo", kind: "llm" },
  ];

  it("v1/models filters to the allowlist instead of leaking the whole catalog", async () => {
    h.state.models = [...catalog];

    const res = await modelsRoute.GET(req("k-allow"));
    const body = await res.json();

    expect(body.data.map((m) => m.id)).toEqual(["za/glm-5.3-flash"]);
    // The route asked the shared decision function, not a private copy.
    expect(h.state.allowlistCalls.map((c) => c[0])).toContain("za/gpt-5");
  });

  it("v1/models stays unfiltered when no key is supplied at all", async () => {
    h.state.models = [...catalog];

    const res = await modelsRoute.GET(req(null));
    const body = await res.json();

    expect(body.data).toHaveLength(3);
  });

  it("the kind-listing shape filters too", async () => {
    h.state.models = [...catalog];

    const res = await kindRoute.GET(req("k-allow"), { params: Promise.resolve({ kind: "llm", path: [] }) });
    const body = await res.json();

    expect(body.data.map((m) => m.id)).toEqual(["za/glm-5.3-flash"]);
  });
});

describe("the dashboard key list stays masked and gated", () => {
  it("every row carries a masked display form, never the raw secret as the label", async () => {
    h.state.keys = [
      {
        id: "key-1",
        name: "probe",
        key: "vr-live-SECRETVALUE-0123456789",
        keyDisplay: maskApiKey("vr-live-SECRETVALUE-0123456789"),
      },
    ];

    const body = await (await keysRoute.GET()).json();
    const row = body.keys[0];

    expect(row.keyDisplay).toBe("vr-l…6789");
    expect(row.keyDisplay).not.toContain("SECRETVALUE");
  });

  it("a short key collapses to the masked unknown, leaking no entropy", () => {
    expect(maskApiKey("short")).toBe(MASKED_UNKNOWN);
    expect(maskApiKey("exactly12chr")).toBe(MASKED_UNKNOWN);
    expect(maskApiKey(undefined)).toBe(MASKED_UNKNOWN);
  });

  it("/api/keys is still in dashboardGuard's protected list", () => {
    // The route hands the plaintext key to the dashboard on purpose; the only
    // thing standing between that and the public internet is this list.
    const src = readFileSync(resolve(__dirname, "../../src/dashboardGuard.js"), "utf8");
    const protectedBlock = src.slice(src.indexOf("const PROTECTED_API_PATHS"));
    expect(protectedBlock.slice(0, protectedBlock.indexOf("]"))).toContain('"/api/keys"');
  });
});
