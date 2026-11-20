import { afterEach, describe, expect, it, vi } from "vitest";
import { getProvider } from "../../src/lib/oauth/providers.js";

// Ported from 9router-go internal/proxy/oauth/nous.go RefreshNousAccessToken.
// The agent-key endpoint was probed live before porting: an inference:invoke-only
// token gets HTTP 403 {"error":"insufficient_scope","error_description":"Access
// token missing required scope: inference:mint_agent_key"} — so the scope bump in
// registry/nous.js is load-bearing, and the mint must fail open for older grants.
const nous = getProvider("nous");

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("nous mintAgentKey", () => {
  it("returns the minted key, id and expiry on success", async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ api_key: "agent-key-abc", key_id: "key-1", expires_at: "2026-11-20T12:00:00Z" }),
    }));
    const out = await nous.mintAgentKey("access-token");
    expect(out).toEqual({ apiKey: "agent-key-abc", keyId: "key-1", expiresAt: "2026-11-20T12:00:00Z" });
  });

  it("asks for a 2h TTL and bears the access token", async () => {
    let seenUrl = null;
    let seenInit = null;
    stubFetch(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, json: async () => ({ api_key: "k" }) };
    });
    await nous.mintAgentKey("tok-123");
    expect(seenUrl).toBe("https://portal.nousresearch.com/api/oauth/agent-key");
    expect(seenInit.headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(seenInit.body).min_ttl_seconds).toBe(7200);
  });

  it("fails open on 403 insufficient_scope (grant predates the scope bump)", async () => {
    stubFetch(async () => ({ ok: false, status: 403 }));
    expect(await nous.mintAgentKey("old-scope-token")).toBeNull();
  });

  it("fails open on a network throw instead of losing the login", async () => {
    stubFetch(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await nous.mintAgentKey("tok")).toBeNull();
  });

  it("fails open when the response carries no api_key", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ key_id: "k" }) }));
    expect(await nous.mintAgentKey("tok")).toBeNull();
  });

  it("does not call the portal without an access token", async () => {
    const spy = vi.fn();
    stubFetch(spy);
    expect(await nous.mintAgentKey("")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("nous mapTokens", () => {
  const tokens = {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    scope: "inference:invoke inference:mint_agent_key",
    inference_base_url: "https://inference-api.nousresearch.com/v1",
  };

  it("promotes the minted agent key to apiKey so the executor prefers it", () => {
    const out = nous.mapTokens(tokens, {
      user: { email: "a@b.c" },
      minted: { apiKey: "agent-key", keyId: "kid", expiresAt: "2026-11-20T12:00:00Z" },
    });
    expect(out.apiKey).toBe("agent-key");
    expect(out.accessToken).toBe("at");
    expect(out.providerSpecificData.nousAgentKeyId).toBe("kid");
    expect(out.providerSpecificData.nousAgentKeyExpiresAt).toBe("2026-11-20T12:00:00Z");
  });

  it("keeps the pre-port shape when no key was minted (no apiKey column written)", () => {
    const out = nous.mapTokens(tokens, { user: { email: "a@b.c" }, minted: null });
    expect(out.apiKey).toBeUndefined();
    expect(out.accessToken).toBe("at");
    expect(out.providerSpecificData.nousAgentKeyId).toBeUndefined();
    expect(out.providerSpecificData.authMethod).toBe("device_code");
    expect(out.providerSpecificData.inferenceBaseUrl).toBe(tokens.inference_base_url);
  });

  it("survives a null extra (postExchange threw)", () => {
    const out = nous.mapTokens(tokens, null);
    expect(out.apiKey).toBeUndefined();
    expect(out.refreshToken).toBe("rt");
    expect(out.scope).toBe(tokens.scope);
    expect(out.expiresAt).toBeTruthy();
  });
});