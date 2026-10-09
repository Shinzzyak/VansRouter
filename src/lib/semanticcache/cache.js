/**
 * Prompt cache: exact-match replay of completed chat responses.
 *
 * Off by default. The default instance is inert until something calls
 * `defaultCache.setEnabledPredicate(...)`, so adding this module to the request
 * path changes no behaviour on its own.
 *
 * Only non-streaming, successful, JSON responses are candidates. A streaming
 * turn cannot be replayed from a stored body without rebuilding the SSE frame
 * sequence, and a stored error would keep serving the failure after the upstream
 * recovered — both are deliberate exclusions rather than gaps.
 */

import { LruStore } from "./store.js";
import { buildCacheKey, extractPromptText } from "./key.js";

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Approximates the tokens a replayed body saved. The upstream `usage` block is
 * authoritative when present; otherwise the usual 4-characters-per-token rule is
 * a floor that keeps the counter moving instead of reporting a flat zero.
 */
export function estimateTokens(body) {
  if (!body) return 0;
  try {
    const parsed = JSON.parse(body);
    const total = parsed?.usage?.total_tokens;
    if (Number.isFinite(total) && total > 0) return total;
  } catch {
    // A body that is not JSON still has a length; fall through to the estimate.
  }
  return Math.max(1, Math.floor(body.length / 4));
}

export class SemanticCache {
  /**
   * @param {{ enabled?: boolean, maxEntries?: number, ttlMs?: number, store?: LruStore, enabledFn?: (() => boolean) | null }} [config]
   */
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled === true,
      maxEntries: config.maxEntries > 0 ? config.maxEntries : DEFAULT_MAX_ENTRIES,
      ttlMs: config.ttlMs > 0 ? config.ttlMs : DEFAULT_TTL_MS,
    };
    this.store = config.store || new LruStore(this.config.maxEntries, this.config.ttlMs);
    this.enabledFn = config.enabledFn || null;
    this.hits = 0;
    this.misses = 0;
    this.tokensSaved = 0;
    this.expired = 0;
  }

  /** Caching is active. An injected predicate wins over the static flag. */
  enabled() {
    return this.enabledFn ? this.enabledFn() === true : this.config.enabled;
  }

  /**
   * Looks up a completed response for this request.
   *
   * @returns {{ hit: false } | { hit: true, body: string, contentType: string, model: string }}
   */
  lookup(request, { sessionId = "" } = {}) {
    if (!this.enabled() || request?.stream === true) return { hit: false };

    const key = buildCacheKey(request, { sessionId });
    if (!key) return { hit: false };

    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return { hit: false };
    }

    // The key already covers the model, so this can only fire for an entry
    // written by an older key scheme. Treat it as a miss rather than serving a
    // body whose provenance no longer matches.
    if (entry.model && request.model && entry.model !== request.model) {
      this.misses += 1;
      return { hit: false };
    }

    const saved = estimateTokens(entry.body);
    this.hits += 1;
    this.tokensSaved += saved;
    this.store.recordHit(key, saved);

    return { hit: true, body: entry.body, contentType: entry.contentType, model: entry.model };
  }

  /**
   * Stores a completed response body.
   *
   * @returns {boolean} whether the body was stored
   */
  put(request, body, { contentType = "application/json", status = 200, sessionId = "" } = {}) {
    if (!this.enabled() || request?.stream === true) return false;
    if (typeof body !== "string" || body.length === 0) return false;
    // A stored error would outlive the failure it recorded.
    if (status < 200 || status >= 300) return false;

    const key = buildCacheKey(request, { sessionId });
    if (!key) return false;

    this.store.put(key, {
      model: typeof request.model === "string" ? request.model : "",
      body,
      contentType: contentType || "application/json",
      storedAt: Date.now(),
      hitCount: 0,
      tokensSaved: 0,
    });
    return true;
  }

  /** Counters plus store occupancy. */
  stats() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled(),
      memoryEntries: this.store.len(),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}` : "0.0",
      tokensSaved: this.tokensSaved,
      maxEntries: this.config.maxEntries,
      ttlMs: this.config.ttlMs,
    };
  }

  /** Entry metadata for a dashboard, newest first. Never returns bodies. */
  listEntries({ page = 1, limit = 20, search = "", model = "", sortBy = "created_at", sortOrder = "desc" } = {}) {
    const searchLower = String(search || "").toLowerCase();
    const modelLower = String(model || "").toLowerCase();

    let rows = this.store.entries().filter((e) => {
      if (modelLower && String(e.model).toLowerCase() !== modelLower) return false;
      if (searchLower && !e.key.toLowerCase().includes(searchLower)) return false;
      return true;
    });

    const direction = sortOrder === "asc" ? 1 : -1;
    const field = { hits: "hitCount", hit_count: "hitCount", tokens_saved: "tokensSaved", model: "model" }[sortBy] || "storedAt";
    rows = rows.sort((a, b) => {
      if (field === "model") return direction * String(a.model).localeCompare(String(b.model));
      return direction * ((a[field] || 0) - (b[field] || 0));
    });

    const total = rows.length;
    const size = limit > 0 ? limit : 20;
    const start = (Math.max(page, 1) - 1) * size;

    return {
      total,
      page: Math.max(page, 1),
      limit: size,
      entries: rows.slice(start, start + size).map((e) => ({
        id: e.key,
        signature: e.key,
        model: e.model,
        hitCount: e.hitCount,
        tokensSaved: e.tokensSaved,
        createdAt: new Date(e.storedAt).toISOString(),
        expiresAt: this.config.ttlMs > 0 ? new Date(e.storedAt + this.config.ttlMs).toISOString() : "",
      })),
    };
  }

  deleteEntry(key) {
    return this.store.delete(key);
  }

  invalidateByModel(model) {
    return this.store.invalidateByModel(model);
  }

  invalidateOlderThan(ageMs) {
    const count = this.store.invalidateOlderThan(ageMs);
    this.expired += count;
    return count;
  }

  clear() {
    this.store.clear();
  }

  len() {
    return this.store.len();
  }
}

/** The process-wide instance. Inert until a predicate is installed. */
export const defaultCache = new SemanticCache();

/**
 * Turns the process-wide cache on or off. Kept as a setter so the enabled state
 * can be driven by a settings read without making the request path async.
 */
export function setCacheEnabledPredicate(fn) {
  defaultCache.enabledFn = typeof fn === "function" ? fn : null;
}

export { buildCacheKey, extractPromptText };
