import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/device/poll — body { provider, deviceCode, codeVerifier,
// extraData, proxyPoolId }. 9router-go URL shape for polling a device-code flow.
export async function POST(request) {
  return oauthAlias(request, "poll", { forwardMethod: "POST" });
}
