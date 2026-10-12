import { getSettings, getApiKeyUsageSnapshot } from "@/lib/localDb";
import { isValidApiKey, extractApiKey, isProviderAllowed, isComboAllowed, isKindAllowed, clientIp } from "@/sse/services/auth.js";
import { checkApiKeyLimits } from "@/lib/db/repos/apiKeyUsageRepo.js";

export const dynamic = "force-dynamic";

// GET /api/v1/key — self-serve status for the key doing the asking.
//
// Resale surface: a seller hands a buyer a key and the buyer needs to see, with
// that same key and nothing else, whether it is still alive, when it expires,
// what it may reach and how much of its quota is left. Before this the only
// reader of that policy was the admin dashboard (CLI token), so every "is my
// key dead?" question had to be answered by the seller by hand.
//
// The secret itself is never echoed back — only the masked display form, same
// as the dashboard rows.
const CORS = { "Access-Control-Allow-Origin": "*" };

const json = (body, status = 200, extra = {}) =>
  Response.json(body, { status, headers: { ...CORS, ...extra } });

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request) {
  try {
    const settings = await getSettings();
    const supplied = extractApiKey(request);

    if (!supplied) {
      return json(
        { error: { message: "Missing API key", type: "authentication_error" } },
        401,
      );
    }

    // requireApiKey only decides whether an unresolvable key is fatal here.
    // A key that IS supplied always has to resolve, otherwise this endpoint
    // would hand policy (limits, expiry) to a caller holding a dead secret.
    const apiKeyInfo = await isValidApiKey(supplied, request);
    if (!apiKeyInfo) {
      return json(
        { error: { message: "Invalid, expired or disabled API key", type: "authentication_error" } },
        401,
      );
    }
    void settings;

    const gate = checkApiKeyLimits(apiKeyInfo, 0);
    const usage = getApiKeyUsageSnapshot(apiKeyInfo);

    return json({
      object: "key",
      id: apiKeyInfo.id,
      name: apiKeyInfo.name,
      keyDisplay: apiKeyInfo.keyDisplay,
      isActive: apiKeyInfo.isActive,
      createdAt: apiKeyInfo.createdAt,
      expiresAt: apiKeyInfo.expiresAt,
      lastUsedAt: apiKeyInfo.lastUsedAt,
      usedCount: apiKeyInfo.usedCount,
      personaInject: apiKeyInfo.personaInject,
      limits: {
        maxTokens: apiKeyInfo.maxTokens,
        maxTokensDaily: apiKeyInfo.maxTokensDaily,
        rpm: apiKeyInfo.rpm,
        rph: apiKeyInfo.rph,
        rpd: apiKeyInfo.rpd,
        tokens5h: apiKeyInfo.tokens5h,
        tokensWeekly: apiKeyInfo.tokensWeekly,
        tokensMonthly: apiKeyInfo.tokensMonthly,
        rateLimitTpm: apiKeyInfo.rateLimitTpm,
        rateLimitConcurrency: apiKeyInfo.rateLimitConcurrency,
        // Prepaid balance: the number a buyer actually cares about ("how much
        // have I got left"), so it is reported next to the caps.
        tokenBalance: apiKeyInfo.tokenBalance,
        tokensSpent: apiKeyInfo.tokensSpent ?? 0,
      },
      usage,
      // Same gate the dispatch path applies before serving a request, so a
      // buyer can tell "rate limited" apart from "out of quota" without a 429.
      gate: {
        allowed: gate.allowed,
        reason: gate.reason ?? null,
        retryAfterMs: gate.retryAfterMs ?? null,
      },
      access: {
        providers: apiKeyInfo.allowedProviders,
        combos: apiKeyInfo.allowedCombos,
        kinds: apiKeyInfo.allowedKinds,
        models: apiKeyInfo.allowedModels || [],
        ips: apiKeyInfo.allowedIps,
      },
      // The address the router attributes this call to. Without it an IP-bound
      // key is undebuggable from the buyer's side ("works from my server" vs
      // "why is it 403") — they can compare this against the ips list above.
      sourceIp: clientIp(request),
    });
  } catch (error) {
    console.log("Error reading own key status:", error);
    return json({ error: { message: "Failed to read key status", type: "server_error" } }, 500);
  }
}

// Re-exported for the unit suite: the access-resolution helpers are what turn a
// stored allow-list into a yes/no, and a test asserting the endpoint's shape
// should exercise the same functions the dispatch path uses.
export { isProviderAllowed, isComboAllowed, isKindAllowed };
