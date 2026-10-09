/**
 * Prometheus metrics for the gateway.
 *
 * Zero dependencies: the exposition format is a dozen lines of string building,
 * so a client library would buy nothing but a supply-chain entry. The registry is
 * per-module-instance rather than a process-global singleton, mirroring the Go
 * router's `observ` package — two instances (tests, an embedded second gateway)
 * cannot collide with each other.
 *
 * Cardinality is the failure mode of this module. Every label value is bounded by
 * `label()`, and every label vocabulary that comes from outside the gateway
 * (token kinds, fallback reasons, status codes) is a closed set. A free-form
 * label would multiply the series count by whatever a caller invents, and this
 * runs on a VPS whose memory the gateway also needs.
 */

import { createHash } from "node:crypto";

/** Bounds every label value. Model names and error classes come from outside. */
const MAX_LABEL_LEN = 64;

/**
 * Stands in for an empty value. An empty label is legal in Prometheus but reads
 * as a rendering bug in a dashboard and collides with "not set" from every other
 * exporter.
 */
const UNKNOWN = "unknown";

/** Token kinds recorded on tokens_total. Closed on purpose (see module note). */
export const TOKEN_KIND_PROMPT = "prompt";
export const TOKEN_KIND_COMPLETION = "completion";
const TOKEN_KINDS = new Set([TOKEN_KIND_PROMPT, TOKEN_KIND_COMPLETION]);

/** Fallback reasons recorded on fallbacks_total. Closed on purpose. */
export const FALLBACK_UPSTREAM_ERROR = "upstream_error";
export const FALLBACK_NO_CONNECTION = "no_connection";
export const FALLBACK_UNHEALTHY = "unhealthy";
const FALLBACK_REASONS = new Set([
  FALLBACK_UPSTREAM_ERROR, FALLBACK_NO_CONNECTION, FALLBACK_UNHEALTHY,
  "rate_limit", "timeout", "model_unavailable", "combo_exhausted",
]);

/**
 * Latency buckets span a fast cached token (50ms) to a very slow streamed turn
 * (2min). TTFT stops at 30s: past that is a stuck socket, and the +Inf bucket
 * catches it without needing a bucket per minute.
 */
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const TTFT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];

/**
 * Reports whether v is shaped like an API key or bearer token rather than like a
 * provider name, model name or HTTP path.
 *
 * A value that looks like a credential is collapsed to UNKNOWN rather than
 * truncated: never exposing a plaintext key has to hold even when a future call
 * site hands the wrong argument to the wrong collector, and a truncated key is
 * still a leaked prefix.
 */
function looksLikeCredential(v) {
  const lower = v.toLowerCase();
  if (lower.startsWith("sk-") || lower.startsWith("sk_") ||
      lower.startsWith("bearer ") || lower.startsWith("bearer\t")) {
    return true;
  }
  // A long opaque run of mixed-case letters and digits with no separator is a
  // token; every real provider/model/endpoint label contains a separator or a
  // lowercase word.
  // A JWT's header always base64url-encodes to a run starting "eyJ" (`{"`), and
  // the three dot-separated segments keep it below the mixed-case heuristic, so
  // it needs its own check.
  if (lower.startsWith("eyj") && v.split(".").length === 3) return true;
  if (v.length < 24 || /[-_/.: ]/.test(v)) return false;
  let digits = 0, lowerCount = 0, upperCount = 0, other = 0;
  for (const ch of v) {
    if (ch >= "0" && ch <= "9") digits++;
    else if (ch >= "a" && ch <= "z") lowerCount++;
    else if (ch >= "A" && ch <= "Z") upperCount++;
    else other++;
  }
  if (other > 0) return false;
  // Mixed case plus digits over a long run: no such provider name exists.
  return upperCount > 0 && digits > 0;
}

/** Returns a bounded, non-empty label value that is safe to expose. */
export function label(v) {
  const s = String(v ?? "").trim();
  if (s === "" || looksLikeCredential(s)) return UNKNOWN;
  return s.length > MAX_LABEL_LEN ? s.slice(0, MAX_LABEL_LEN) : s;
}

/**
 * Derives a short, stable, non-reversible id from a key identifier. Exists so
 * per-key visibility is possible without ever putting a credential — or a value
 * that identifies one by inspection — in a label.
 */
export function keyRef(keyId) {
  const s = String(keyId ?? "").trim();
  if (s === "") return UNKNOWN;
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Renders an HTTP status code as a label value. */
export function statusLabel(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n <= 0) return UNKNOWN;
  return String(Math.trunc(n));
}

/** Escapes a label value per the Prometheus text exposition format. */
function escapeLabelValue(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Renders a label set. Empty sets render as nothing (bare metric name). */
function renderLabels(pairs) {
  const entries = pairs.filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  return "{" + entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",") + "}";
}

/** A counter keyed by a fixed label-name tuple. */
class Counter {
  constructor(name, help, labelNames) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.series = new Map();
  }

  with(values) {
    const key = values.join("\u0000");
    let s = this.series.get(key);
    if (!s) {
      s = { values, value: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  inc(values, by = 1) {
    const n = Number(by);
    if (!Number.isFinite(n) || n <= 0) return;
    this.with(values).value += n;
  }

  render(out) {
    out.push(`# HELP ${this.name} ${this.help}`);
    out.push(`# TYPE ${this.name} counter`);
    for (const s of this.series.values()) {
      out.push(`${this.name}${renderLabels(this.labelNames.map((n, i) => [n, s.values[i]]))} ${s.value}`);
    }
  }
}

/** A histogram keyed by a fixed label-name tuple plus a fixed bucket set. */
class Histogram {
  constructor(name, help, labelNames, buckets) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
    this.series = new Map();
  }

  observe(values, amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const key = values.join("\u0000");
    let s = this.series.get(key);
    if (!s) {
      s = { values, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (n <= this.buckets[i]) s.counts[i]++;
    }
    s.sum += n;
    s.count++;
  }

  render(out) {
    out.push(`# HELP ${this.name} ${this.help}`);
    out.push(`# TYPE ${this.name} histogram`);
    for (const s of this.series.values()) {
      const base = this.labelNames.map((n, i) => [n, s.values[i]]);
      for (let i = 0; i < this.buckets.length; i++) {
        out.push(`${this.name}_bucket${renderLabels([...base, ["le", String(this.buckets[i])]])} ${s.counts[i]}`);
      }
      out.push(`${this.name}_bucket${renderLabels([...base, ["le", "+Inf"]])} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(base)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(base)} ${s.count}`);
    }
  }
}

/** Owns one registry and the collectors in it. */
export class Metrics {
  constructor() {
    this.requestsTotal = new Counter(
      "router_requests_total",
      "Completed gateway requests by provider, model, endpoint and outcome.",
      ["provider", "model", "endpoint", "status"]
    );
    this.requestDuration = new Histogram(
      "router_request_duration_seconds",
      "End-to-end gateway request duration by provider and model.",
      ["provider", "model"],
      LATENCY_BUCKETS
    );
    this.timeToFirstToken = new Histogram(
      "router_time_to_first_token_seconds",
      "Time from request start to the first streamed chunk; only observed for streaming turns.",
      ["provider", "model"],
      TTFT_BUCKETS
    );
    this.tokensTotal = new Counter(
      "router_tokens_total",
      "Tokens billed through the gateway, split by kind.",
      ["provider", "model", "kind"]
    );
    this.fallbacks = new Counter(
      "router_fallbacks_total",
      "Requests that moved to another upstream connection or provider.",
      ["provider", "model", "reason"]
    );
    this.upstreamErrors = new Counter(
      "router_upstream_errors_total",
      "Upstream responses the gateway treated as errors.",
      ["provider", "model", "status"]
    );
  }

  /** Counts one completed request. status is the HTTP status the client saw. */
  recordRequest(provider, model, endpoint, status) {
    this.requestsTotal.inc([label(provider), label(model), label(endpoint), statusLabel(status)]);
  }

  /** Observes the end-to-end latency of one request, in milliseconds. */
  recordDuration(provider, model, millis) {
    const n = Number(millis);
    if (!Number.isFinite(n) || n <= 0) return;
    this.requestDuration.observe([label(provider), label(model)], n / 1000);
  }

  /**
   * Observes time-to-first-token, in milliseconds. A non-positive value means
   * the turn did not stream (or never produced a first chunk) and is dropped
   * rather than recorded as a suspiciously instant response.
   */
  recordTTFT(provider, model, millis) {
    const n = Number(millis);
    if (!Number.isFinite(n) || n <= 0) return;
    this.timeToFirstToken.observe([label(provider), label(model)], n / 1000);
  }

  /** Adds n tokens of the given kind. Non-positive counts are dropped. */
  addTokens(provider, model, kind, n) {
    // A kind outside the closed set is a caller bug. Dropping it keeps the
    // series count bounded instead of minting a new one per typo.
    if (!TOKEN_KINDS.has(kind)) return;
    this.tokensTotal.inc([label(provider), label(model), kind], n);
  }

  /** Counts one fallback move. reason is one of the FALLBACK_* constants. */
  incFallback(provider, model, reason) {
    if (!FALLBACK_REASONS.has(reason)) return;
    this.fallbacks.inc([label(provider), label(model), reason]);
  }

  /** Counts one upstream error, tagged with the upstream status (0 = none yet). */
  incUpstreamError(provider, model, status) {
    this.upstreamErrors.inc([label(provider), label(model), statusLabel(status)]);
  }

  /**
   * The single call the request-completion path makes: one request, its latency,
   * its tokens and — for a streaming turn — its time to first token.
   *
   * There is deliberately no cost argument. The completion path carries token
   * counts, not money; pricing is applied at read time by the dashboard. A
   * cost counter here could only ever publish zero, which reads as "spend is
   * zero" rather than "not measured".
   */
  recordUsage(provider, model, endpoint, status, latencyMillis, promptTokens, completionTokens, ttftMillis) {
    this.recordRequest(provider, model, endpoint, status);
    this.recordDuration(provider, model, latencyMillis);
    this.recordTTFT(provider, model, ttftMillis);
    this.addTokens(provider, model, TOKEN_KIND_PROMPT, promptTokens);
    this.addTokens(provider, model, TOKEN_KIND_COMPLETION, completionTokens);
  }

  /** Renders the registry in the Prometheus text exposition format. */
  render() {
    const out = [];
    for (const collector of [
      this.requestsTotal, this.requestDuration, this.timeToFirstToken,
      this.tokensTotal, this.fallbacks, this.upstreamErrors,
    ]) {
      collector.render(out);
    }
    return out.join("\n") + "\n";
  }
}

/** The process-wide instance. */
export const defaultMetrics = new Metrics();

/** Convenience wrappers over the default instance. */
export const recordUsage = (...args) => defaultMetrics.recordUsage(...args);
export const recordRequest = (...args) => defaultMetrics.recordRequest(...args);
export const recordDuration = (...args) => defaultMetrics.recordDuration(...args);
export const recordTTFT = (...args) => defaultMetrics.recordTTFT(...args);
export const addTokens = (...args) => defaultMetrics.addTokens(...args);
export const incFallback = (...args) => defaultMetrics.incFallback(...args);
export const incUpstreamError = (...args) => defaultMetrics.incUpstreamError(...args);
