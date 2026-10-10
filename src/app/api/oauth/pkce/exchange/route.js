import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/pkce/exchange — body carries { provider, code, codeVerifier,
// redirectUri, state }. 9router-go URL shape; the exchange runs in the generic
// [provider]/[action] handler.
export async function POST(request) {
  return oauthAlias(request, "exchange", { forwardMethod: "POST" });
}
