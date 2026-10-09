// Guardrail engine: a resolved policy applied to text.
//
// The engine holds no state, so one instance serves concurrent requests without
// a lock. It is constructed per request from a resolved policy and is inert
// unless that policy enabled a detector set with an action other than "allow" —
// an install that never configured guardrails pays one policy lookup and
// nothing else.
//
// Ported from 9router-go internal/guardrails/engine.go.

import { DETECTOR_SETS, appliedSpans, maskFindings, runDetectors } from "./detectors.js";

/** What fires when a detector matches. Ordered, so the strictest verdict wins. */
export const ACTION = {
  allow: "allow",
  log_only: "log_only",
  mask: "mask",
  block: "block",
};

const ACTION_RANK = {
  [ACTION.allow]: 0,
  [ACTION.log_only]: 1,
  [ACTION.mask]: 2,
  [ACTION.block]: 3,
};

/** The stricter of two actions. Used when several strings in one payload fire. */
export function strictestAction(a, b) {
  return (ACTION_RANK[b] ?? 0) > (ACTION_RANK[a] ?? 0) ? b : a;
}

export class GuardrailEngine {
  /**
   * @param {string[]} detectors detector set names ("pii", "injection")
   * @param {string} action what fires on a match
   */
  constructor(detectors = [], action = ACTION.log_only) {
    this.detectors = detectors.filter((name) => name in DETECTOR_SETS);
    this.action = action in ACTION_RANK ? action : ACTION.log_only;
  }

  /** A disabled engine must not rewrite content, so callers check this first. */
  enabled() {
    return this.detectors.length > 0 && this.action !== ACTION.allow;
  }

  runs(name) {
    return this.detectors.includes(name);
  }

  /**
   * Evaluates text and returns the decision.
   *
   * Findings from every enabled set are collected before the action is applied,
   * so one decision covers the whole message and the audit log records
   * everything that matched rather than only what stopped it.
   */
  scan(text) {
    if (!this.enabled() || !text) return { action: ACTION.allow, findings: [] };

    let findings = [];
    for (const name of this.detectors) {
      findings = findings.concat(runDetectors(DETECTOR_SETS[name], text));
    }
    if (!findings.length) return { action: ACTION.allow, findings: [] };

    const decision = { action: this.action, findings };
    if (this.action === ACTION.mask) {
      const mutated = maskFindings(text, findings);
      if (mutated !== text) {
        decision.mutated = mutated;
        // The spans that were actually replaced, in original coordinates. The
        // outbound tap needs these to write the replacement back into the exact
        // event that carried it; re-deriving them from the text is a guess.
        decision.regions = appliedSpans(text, findings);
      }
    }
    return decision;
  }

  /**
   * Walks a decoded request or response payload and applies the engine to every
   * string value in it.
   *
   * The caller has already parsed the body, so rewriting strings in place
   * avoids re-serialising structures the gateway does not understand. A
   * non-object payload is scanned as a plain string.
   */
  scanJson(payload) {
    if (!this.enabled()) return { payload, action: ACTION.allow, findings: [], mutated: false };

    let worst = ACTION.allow;
    let findings = [];
    let mutated = false;

    const walk = (value, path) => {
      if (typeof value === "string") {
        const decision = this.scan(value);
        worst = strictestAction(worst, decision.action);
        // Findings carry the path of the string they came from. The same value
        // can sit in a dozen places in one payload and an audit entry that only
        // says "email matched" is not actionable.
        for (const finding of decision.findings) findings.push({ ...finding, path });
        if (decision.mutated !== undefined) {
          mutated = true;
          return decision.mutated;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`));
      if (value && typeof value === "object") {
        for (const key of Object.keys(value)) value[key] = walk(value[key], path ? `${path}.${key}` : key);
        return value;
      }
      return value;
    };

    const out = walk(payload, "");
    if (!findings.length) return { payload: out, action: ACTION.allow, findings: [], mutated: false };
    return { payload: out, action: worst, findings, mutated };
  }
}

/** True when a decision means the request or response must not be forwarded as-is. */
export function blocked(decision) {
  return decision?.action === ACTION.block;
}

/** True when a decision carries a rewritten body that must replace the original. */
export function wasMutated(decision) {
  return decision?.mutated !== undefined && decision.mutated !== null;
}

/**
 * The message a client is told when content is cut by a policy. It names no
 * detector and no matched value: a message that said what was found would
 * confirm to a prober exactly which patterns this install runs.
 */
export const BLOCKED_MESSAGE = "Request blocked by a configured guardrail policy.";
export const BLOCKED_RESPONSE_MESSAGE = "Response blocked by a configured guardrail policy";
