// Alias dispatcher for the 9router-go OAuth URL shapes.
//
// The upstream router exposes three flow families as fixed paths
// (/api/oauth/pkce/*, /api/oauth/authcode/*, /api/oauth/device/*) where the
// provider travels in the query string or the body. This deployment exposes the
// same flows as /api/oauth/[provider]/[action], with the provider in the path.
//
// These aliases only translate the URL shape and re-dispatch into that single
// handler — there is exactly one implementation of each flow, so the two URL
// families can never drift apart.

import { GET as genericGET, POST as genericPOST } from "./[provider]/[action]/route.js";

/**
 * Re-dispatch a request into the generic OAuth handler.
 *
 * @param request  incoming Request
 * @param action   action name understood by the generic handler
 * @param options.forwardMethod  "GET" (default) or "POST" — device start is a
 *   POST upstream but a GET branch downstream, so the shape is translated.
 * @param options.queryFromBody  body field -> query param map (device start).
 */
export async function oauthAlias(request, action, options = {}) {
  const { forwardMethod = "GET", queryFromBody = {} } = options;

  const url = new URL(request.url);
  let provider = url.searchParams.get("provider");
  let rawBody;
  let parsedBody;

  if (request.method === "POST") {
    rawBody = await request.text();
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (!provider) provider = parsedBody?.provider || null;
  }

  if (!provider) {
    return Response.json({ error: "unsupported provider" }, { status: 400 });
  }

  for (const [field, param] of Object.entries(queryFromBody)) {
    const value = parsedBody?.[field];
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(param, String(value));
    }
  }

  const forwarded =
    forwardMethod === "POST"
      ? new Request(url, { method: "POST", headers: request.headers, body: rawBody })
      : new Request(url, { method: "GET", headers: request.headers });

  const context = { params: Promise.resolve({ provider, action }) };
  return forwardMethod === "POST" ? genericPOST(forwarded, context) : genericGET(forwarded, context);
}
