import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// GET /api/oauth/pkce/authorize?provider=claude|codex|xai|gitlab
// 9router-go URL shape. The PKCE flow itself lives in the generic
// [provider]/[action] handler; this only moves the provider into the path.
export async function GET(request) {
  return oauthAlias(request, "authorize");
}
