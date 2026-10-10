import { oauthAlias } from "../../_alias.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/device/start — body { provider, region, startUrl, authMethod }.
//
// 9router-go shape: a POST whose options live in the body. This deployment's
// device-code branch is a GET that reads the same options from the query, so the
// alias translates the body fields into query params before dispatching.
export async function POST(request) {
  return oauthAlias(request, "device-code", {
    queryFromBody: { region: "region", startUrl: "start_url", authMethod: "auth_method" },
  });
}
