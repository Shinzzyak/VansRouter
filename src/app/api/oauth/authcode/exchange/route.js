import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/authcode/exchange — body carries { provider, code,
// redirectUri, state }. 9router-go URL shape.
export async function POST(request) {
  return oauthAlias(request, "exchange", { forwardMethod: "POST" });
}
