/**
 * K271 — one correlation id per inbound client request.
 *
 * Before this, a client had no handle on its own request once it left the route
 * handler: the access log, the engine escalation ledger and the provider call all
 * used different ids (or none). Debugging a refusal therefore started by guessing
 * timestamps. The id is echoed from `x-request-id` when the client sends one, so a
 * caller that already tracks requests sees its own value come back.
 *
 * Only the response header is added. The body is passed through untouched — a
 * streaming Response cannot be rewritten after its first chunk is read.
 */
import { randomUUID } from "crypto";

export const REQUEST_ID_HEADER = "x-vansroute-request-id";
const INBOUND_HEADERS = ["x-request-id", "x-correlation-id"];

export function inboundRequestId(request) {
  for (const name of INBOUND_HEADERS) {
    let value;
    try {
      value = request?.headers?.get?.(name);
    } catch {
      // A header with CR/LF makes some Headers implementations throw on read.
      // Treat it as absent rather than letting it kill the request.
      value = undefined;
    }
    if (value && /^[\w.:-]{1,128}$/.test(value)) return value;
  }
  return randomUUID();
}

export function withRequestId(response, requestId) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("access-control-expose-headers",
    [headers.get("access-control-expose-headers"), REQUEST_ID_HEADER].filter(Boolean).join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
