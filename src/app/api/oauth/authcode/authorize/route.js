import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// GET /api/oauth/authcode/authorize?provider=gemini-cli|iflow
// 9router-go URL shape for the plain authorization-code flow.
export async function GET(request) {
  return oauthAlias(request, "authorize");
}
