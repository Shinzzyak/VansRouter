import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";
import { redeemCode } from "@/lib/db/repos/redeemCodesRepo.js";
import { getApiKeyById } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/v1/redeem — the buyer side of the resale flow.
//
// The buyer holds a key and a code; the code is spent against that key, which
// credits its prepaid token balance and/or pushes its expiry out. The key comes
// from the usual Authorization header, so a code can never be spent onto
// somebody else's key by an anonymous caller.
//
// Public prefix (/api/v1) is deliberate: buyers are outside the dashboard, so
// this route authenticates the key itself rather than the dashboard session.
const CORS = { "Access-Control-Allow-Origin": "*" };

const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  try {
    const supplied = extractApiKey(request);
    if (!supplied) {
      return json({ error: { message: "Missing API key", type: "authentication_error" } }, 401);
    }
    const apiKeyInfo = await isValidApiKey(supplied, request);
    if (!apiKeyInfo) {
      return json({ error: { message: "Invalid, expired or disabled API key", type: "authentication_error" } }, 401);
    }

    let code = null;
    try {
      const body = await request.json();
      code = body?.code ?? null;
    } catch {
      return json({ error: { message: "Body must be JSON with a `code` field", type: "invalid_request_error" } }, 400);
    }
    if (!code) {
      return json({ error: { message: "Missing redeem code", type: "invalid_request_error" } }, 400);
    }

    const result = await redeemCode(String(code), apiKeyInfo);
    if (!result.ok) {
      // A spent/unknown/expired code is a normal buyer-side outcome, not a
      // server fault: 400 with the reason, never a 500.
      return json({ error: { message: result.error, type: "invalid_request_error" } }, 400);
    }

    // Read the key back so the response carries the row as it now stands, not
    // just the delta.
    const refreshed = await getApiKeyById(apiKeyInfo.id);
    return json({
      object: "redeem",
      redeemed: true,
      code: result.code,
      creditedTokens: result.creditedTokens,
      extendedDays: result.extendedDays,
      usesRemaining: result.usesRemaining,
      key: {
        id: apiKeyInfo.id,
        name: apiKeyInfo.name,
        keyDisplay: apiKeyInfo.keyDisplay,
        tokenBalance: refreshed?.tokenBalance ?? result.tokenBalance,
        tokensSpent: refreshed?.tokensSpent ?? result.tokensSpent,
        expiresAt: refreshed?.expiresAt ?? result.expiresAt,
        isActive: refreshed?.isActive ?? true,
      },
    });
  } catch (error) {
    console.log("Error redeeming code:", error);
    return json({ error: { message: "Failed to redeem code", type: "server_error" } }, 500);
  }
}
