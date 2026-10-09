// Guardrails: per-scope policy that inspects a request before it reaches the
// provider and the model's reply before it reaches the client.
//
// Off by default. Nothing here runs until a row exists in guardrailPolicies, and
// even then the engine is inert unless that row names a detector set and an
// action other than "allow" — an install that never configures guardrails pays
// one cached policy lookup per request and nothing else.
//
// Ported from 9router-go internal/guardrails (engine + detectors + resolver +
// inbound/outbound taps), reimplemented against this runtime.

import { ACTION, BLOCKED_MESSAGE, BLOCKED_RESPONSE_MESSAGE, GuardrailEngine, blocked } from "./engine.js";
import { filterResponseBody, pipeGuardrailStream } from "./outbound.js";
import { auditDecision, invalidateGuardrailCache, resolveEngine, SCOPE_ORDER } from "./policies.js";
import { getSettings } from "../db/repos/settingsRepo.js";

export { ACTION, BLOCKED_MESSAGE, BLOCKED_RESPONSE_MESSAGE, GuardrailEngine, blocked, strictestAction, wasMutated } from "./engine.js";
export { DETECTOR_SETS, REDACT_MASK, SEVERITY, appliedSpans, runDetectors } from "./detectors.js";
export { SCOPE_ORDER, auditDecision, auditFiring, invalidateGuardrailCache, resolveEngine } from "./policies.js";
export { OutboundFilter, SCAN_WINDOW_CHARS, STREAM_FORMAT, filterResponseBody, pipeGuardrailStream } from "./outbound.js";
// Alias used by the request path: the wire format the client asked for.
export { STREAM_FORMAT as GUARDRAIL_STREAM_FORMAT } from "./outbound.js";
export {
  deleteGuardrailPolicy,
  deleteGuardrailPolicyById,
  getGuardrailPolicy,
  getGuardrailPolicyById,
  listGuardrailPolicies,
  updateGuardrailPolicyById,
  upsertGuardrailPolicy,
} from "../db/repos/guardrailRepo.js";

/**
 * Resolves the engine for a request. Never throws: a policy read that fails
 * yields an inert engine, so a broken config degrades to no filtering instead of
 * taking the request path down.
 *
 * @param {{apiKeyId?: string, model?: string, provider?: string}} target
 */
export async function guardrailsFor(target) {
  try {
    // Global kill-switch, consulted per request like the Go tap's Switch: a
    // policy row is an explicit operator decision, so a configured policy is
    // active unless the operator turns guardrails off. Turning them off must not
    // require deleting the policy — that would take the configuration and the
    // audit trail with it.
    const settings = await getSettings();
    if (settings?.guardrailsEnabled === false) {
      return { engine: new GuardrailEngine([], ACTION.allow), scope: null, policy: null };
    }
    return await resolveEngine(target);
  } catch {
    // A malformed policy row must degrade to "no filtering", never to a broken
    // request path. resolveEngine already absorbs read failures; this guards the
    // engine construction itself.
    return { engine: new GuardrailEngine([], ACTION.allow), scope: null, policy: null };
  }
}

/**
 * The inbound tap: judges a parsed request body.
 *
 * Returns the payload to forward and the action taken. A `block` action is the
 * caller's to enforce — this function never throws, because a guardrail that
 * breaks the request path is worse than the content it was meant to catch.
 *
 * @returns {{action: string, payload: any, message: string|null, findings: any[]}}
 */
export function scanInbound(engine, payload) {
  const inert = { action: ACTION.allow, payload, message: null, findings: [] };
  if (!engine?.enabled() || !payload) return inert;

  const { payload: scanned, action, findings, mutated } = engine.scanJson(payload);
  if (action === ACTION.allow) return inert;
  if (action === ACTION.block) return { action, payload, message: BLOCKED_MESSAGE, findings };
  if (mutated) return { action, payload: scanned, message: null, findings };
  // log_only and mask-with-nothing-replaced both leave the body byte-identical,
  // so the caller's original is forwarded rather than a re-serialised copy.
  return { action, payload, message: null, findings };
}

/**
 * The outbound tap for a whole response: streams get the sliding-window filter,
 * buffered bodies get rewritten in place.
 *
 * A blocked buffered body answers with status 200 and an error-shaped payload
 * rather than a 4xx. The streaming path cannot change the status — headers are
 * already on the wire when the match is found — and a policy that returned 403
 * on one path and 200 on the other would make the same rule look like two
 * different behaviours to the client.
 *
 * @param {import("./engine.js").GuardrailEngine} engine
 * @param {Response} response the response about to be returned to the client
 * @param {string} format one of STREAM_FORMAT
 */
export async function applyOutboundGuard(engine, response, format, onFiring = null) {
  if (!engine?.enabled() || !response?.body) return response;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const body = pipeGuardrailStream(response.body, engine, format, onFiring);
    // The original body is replaced, not consumed, so the headers carry over
    // unchanged — including the ones the client uses to detect a stream.
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const text = await response.text();
  const { body, action, findings } = filterResponseBody(engine, text);
  if (onFiring && action !== ACTION.allow) onFiring({ action, findings });
  if (action === ACTION.block) {
    return new Response(JSON.stringify({ error: { message: BLOCKED_RESPONSE_MESSAGE, type: "guardrail_blocked" } }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (body === text) return response;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const GUARDRAIL_ACTIONS = ACTION;
