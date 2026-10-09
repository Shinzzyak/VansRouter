// Policy resolution: which engine, if any, applies to one request.
//
// Scopes are checked narrowest-first so a per-key rule beats a per-provider one.
// The first *enabled* row wins; a disabled row means "not this scope", not
// "nothing applies", which is what lets a global rule cover every key while a
// single key opts out.
//
// Ported from 9router-go internal/guardrails/resolver.go.

import { getGuardrailPolicy } from "../db/repos/guardrailRepo.js";
import { insertGuardrailLog } from "../db/repos/guardrailLogRepo.js";
import { ACTION, GuardrailEngine } from "./engine.js";
import { SEVERITY } from "./detectors.js";
import { incGuardrailDecision } from "../observ/metrics.js";

/** Narrowest scope first. Order is the contract: the resolver walks it in turn. */
export const SCOPE_ORDER = ["apikey", "model", "provider", "global"];

/** Orders severities so the worst finding on a decision can be picked out. */
const SEVERITY_RANK = SEVERITY;
const SEVERITY_NAME = Object.fromEntries(Object.entries(SEVERITY).map(([name, rank]) => [rank, name]));

/** Detectors report severity as a rank (1..3); the log stores the name. */
function severityName(severity) {
  if (typeof severity === "string") return SEVERITY[severity] ? severity : "low";
  return SEVERITY_NAME[severity] || "low";
}

// A policy row is read at most once per TTL. The dashboard writes invalidate
// the cache immediately, so the TTL only bounds staleness from an out-of-band
// edit; it is not the correctness mechanism.
const CACHE_TTL_MS = 5000;
const cache = new Map();

/** Drops the resolver cache. Called by every policy write. */
export function invalidateGuardrailCache() {
  cache.clear();
}

function cacheKey(scope, scopeId) {
  return `${scope}:${scopeId || ""}`;
}

async function loadPolicy(scope, scopeId) {
  const key = cacheKey(scope, scopeId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.policy;

  let policy = null;
  try {
    policy = await getGuardrailPolicy(scope, scopeId);
  } catch {
    // A policy read that fails must not take the gateway down with it. It is
    // recorded as a decision so the failure is visible on /api/metrics instead
    // of silently meaning "no policy configured".
    incGuardrailDecision("config_error", scope);
    policy = null;
  }
  cache.set(key, { policy, expires: Date.now() + CACHE_TTL_MS });
  return policy;
}

/**
 * Builds the engine for a request, or an inert one when no enabled policy
 * matches.
 *
 * @param {{apiKeyId?: string, model?: string, provider?: string}} target
 */
export async function resolveEngine(target = {}) {
  const ids = {
    apikey: target.apiKeyId || "",
    model: target.model || "",
    provider: target.provider || "",
    global: "",
  };

  for (const scope of SCOPE_ORDER) {
    const scopeId = ids[scope];
    // An empty scopeId on a non-global scope is "no rule here", never a match
    // on the empty string: every unconfigured scope would otherwise resolve to
    // whichever row happened to be written with a blank id.
    if (scope !== "global" && !scopeId) continue;
    const policy = await loadPolicy(scope, scopeId);
    if (!policy || !policy.enabled) continue;
    return { engine: new GuardrailEngine(policy.detectors, policy.action), scope, policy };
  }

  return { engine: new GuardrailEngine([], ACTION.allow), scope: null, policy: null };
}

/** Records one decision against the metrics surface. Best-effort. */
export function auditDecision(decision, scope) {
  if (!decision || decision.action === ACTION.allow) return;
  incGuardrailDecision(decision.action, scope || "none");
}

/**
 * Persists one firing to the audit log and bumps the metric.
 *
 * Called from both taps. Deliberately fire-and-forget: the request path must not
 * wait on a disk write, and a write failure must never upgrade a log_only policy
 * into a block. A failing audit is visible as a gap in /api/guardrails/logs, not
 * as a broken request.
 *
 * @param {object} decision  engine decision (action + findings)
 * @param {object} target    {apiKeyId, model}
 * @param {string} scope     scope that resolved the policy
 * @param {"inbound"|"outbound"} direction
 */
export function auditFiring(decision, target, scope, direction) {
  if (!decision || decision.action === ACTION.allow) return;
  incGuardrailDecision(decision.action, scope || "none", direction);
  const findings = Array.isArray(decision.findings) ? decision.findings : [];
  const detectors = [];
  let severity = "low";
  for (const f of findings) {
    if (f.detector && !detectors.includes(f.detector)) detectors.push(f.detector);
    const name = severityName(f.severity);
    if ((SEVERITY_RANK[name] || 0) > (SEVERITY_RANK[severity] || 0)) severity = name;
  }
  // The span text is never stored — only where it was and how bad it looked —
  // so the audit trail cannot become a second copy of the traffic it caught.
  const spans = findings.map((f) => ({ detector: f.detector, start: f.start, end: f.end, severity: severityName(f.severity) }));
  insertGuardrailLog({
    apiKeyId: target?.apiKeyId || "",
    model: target?.model || "",
    detector: detectors.join(",") || "unknown",
    direction,
    action: decision.action,
    scope: scope || "",
    reason: decision.reason || "",
    findings: spans,
    severity,
  }).catch(() => {});
}
