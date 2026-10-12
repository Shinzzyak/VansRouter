import { redeemCode } from "@/lib/db/repos/redeemCodesRepo.js";
import { getSettings } from "@/lib/localDb";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

// POST /api/v1/redeem — the buyer's front door.
//
// A buyer holds a code and nothing else; the code is the credential, so this
// route takes no API key. It hands back the key it issues, the base URL to use
// it against, and the quota/validity that came with the code — that is the
// whole contract, deliberately: a buyer needs an address, a secret and a
// number, not a tour of the HTTP surface.
//
// Public prefix (/api/v1) is deliberate; dashboardGuard carves this exact path
// out of the remote-key requirement, because a buyer redeeming is by definition
// not a key holder yet. The code check below plus the lockout is what protects
// it, and a code is 32^12.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// The address a buyer should call. A pinned public base URL wins (the dashboard
// may be reachable on an address the buyer cannot use); otherwise the request's
// own host is the floor.
async function resolveBaseUrl(request) {
  let pinned = "";
  try {
    pinned = String((await getSettings())?.publicBaseUrl || "").trim().replace(/\/+$/, "");
  } catch {}
  if (pinned) return `${pinned}/v1`;
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("host") || "";
  return host ? `${proto}://${host}/v1` : "/v1";
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return json(
        { error: { message: `Too many attempts. Try again in ${lock.retryAfter}s`, type: "rate_limit_error" } },
        429
      );
    }

    let code = null;
    try {
      const body = await request.json();
      code = body?.code ?? null;
    } catch {
      return json({ error: { message: "Body must be JSON with a `code` field", type: "invalid_request_error" } }, 400);
    }
    if (!code || typeof code !== "string") {
      return json({ error: { message: "Missing redeem code", type: "invalid_request_error" } }, 400);
    }

    const result = await redeemCode(code, { ip });
    if (!result.ok) {
      // A spent/unknown/revoked/expired code is a normal buyer-side outcome, not
      // a server fault: 400 with the reason, never a 500.
      recordFail(ip);
      return json({ error: { message: result.error, type: "invalid_request_error" } }, 400);
    }
    recordSuccess(ip);

    return json({
      object: "redeem",
      redeemed: true,
      code: result.code,
      name: result.key.name,
      api_key: result.key.key,
      key_display: result.key.keyDisplay,
      base_url: await resolveBaseUrl(request),
      tokens: result.tokens,
      expires_at: result.expiresAt,
      days: result.days,
      uses_remaining: result.usesRemaining,
    });
  } catch (error) {
    console.log("Error redeeming code:", error);
    return json({ error: { message: "Failed to redeem code", type: "server_error" } }, 500);
  }
}
