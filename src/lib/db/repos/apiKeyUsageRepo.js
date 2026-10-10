import { getAdapter } from "../driver.js";

// In-memory rolling counters. We intentionally keep these in process memory
// (not the DB) to avoid write amplification on every request and because
// limit enforcement is best-effort across restarts (a restart resets counters).
// For stricter accounting, callers can persist usage via usageRepo after the fact.

if (!global._apiKeyCounters) {
  global._apiKeyCounters = {
    rpm: new Map(),      // keyId -> { ts: minuteTimestamp, count }
    rph: new Map(),      // keyId -> { ts: hourTimestamp, count }
    rpd: new Map(),      // keyId -> { dateKey, count }
    tokens5h: new Map(), // keyId -> [{ ts, tokens }]
    tokensDaily: new Map(),// keyId -> { dateKey, tokens }
    tokensWeekly: new Map(), // keyId -> { weekKey, tokens }
    tokensMonthly: new Map(),// keyId -> { monthKey, tokens }
    tpm: new Map(),      // keyId -> [{ ts, tokens }] rolling 60s window
    inflight: new Map(), // keyId -> [{ ts }] live request leases
  };
}
const counters = global._apiKeyCounters;

// A lease that is never released means the request died before it could report
// usage (client abort, process kill). Sweeping them keeps a crashed stream from
// pinning a resold key's concurrency slot forever.
const LEASE_TTL_MS = 15 * 60_000;

function liveLeases(keyId) {
  const leases = counters.inflight.get(keyId) || [];
  const cutoff = Date.now() - LEASE_TTL_MS;
  const fresh = leases.filter((l) => l.ts > cutoff);
  if (fresh.length !== leases.length) counters.inflight.set(keyId, fresh);
  return fresh;
}

/**
 * Take a concurrency slot for a key. Callers that pass the limit gate MUST
 * release (directly, or indirectly by letting recordApiKeyUsage run).
 * @returns {{ keyId: string, ts: number } | null} null when no key / no limit
 */
export function acquireApiKeyLease(apiKeyInfo) {
  if (!apiKeyInfo) return null;
  const lease = { ts: Date.now() };
  const leases = liveLeases(apiKeyInfo.id);
  leases.push(lease);
  counters.inflight.set(apiKeyInfo.id, leases);
  return { keyId: apiKeyInfo.id, ts: lease.ts };
}

/** Release the oldest outstanding slot for this key. Safe to call twice. */
export function releaseApiKeyLease(apiKeyInfo) {
  if (!apiKeyInfo) return;
  const leases = liveLeases(apiKeyInfo.id);
  if (leases.length === 0) return;
  leases.shift();
  counters.inflight.set(apiKeyInfo.id, leases);
}

function getMinuteTs() {
  return Math.floor(Date.now() / 60000);
}
function getHourTs() {
  return Math.floor(Date.now() / 3600000);
}
function getDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function getWeekKey() {
  const d = new Date();
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(d.getDate() - d.getDay()); // Sunday-based week
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}
function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getRollingTokenCount(map, keyId, windowMs) {
  const now = Date.now();
  const entries = map.get(keyId) || [];
  const fresh = entries.filter((e) => now - e.ts <= windowMs);
  if (fresh.length !== entries.length) map.set(keyId, fresh);
  return fresh.reduce((sum, e) => sum + e.tokens, 0);
}

function bumpCounter(map, keyId, bucketKey, amount = 1) {
  let entry = map.get(keyId);
  if (!entry || entry.key !== bucketKey) {
    entry = { key: bucketKey, count: 0 };
    map.set(keyId, entry);
  }
  entry.count += amount;
  return entry.count;
}

function bumpTokens(map, keyId, amount) {
  let entries = map.get(keyId);
  if (!entries) {
    entries = [];
    map.set(keyId, entries);
  }
  entries.push({ ts: Date.now(), tokens: amount });
}

/**
 * Check per-key limits BEFORE processing a request.
 * @param {object} apiKeyInfo - key row from apiKeysRepo
 * @param {number} requestedTokens - estimated tokens for this request (0 if unknown)
 * @returns {{ allowed: boolean, reason?: string, retryAfterMs?: number }}
 */
export function checkApiKeyLimits(apiKeyInfo, requestedTokens = 0) {
  if (!apiKeyInfo) return { allowed: true };
  const keyId = apiKeyInfo.id;
  const tokens = Math.max(0, Number(requestedTokens) || 0);

  // RPM
  const rpmLimit = apiKeyInfo.rpm;
  if (rpmLimit != null) {
    const minute = getMinuteTs();
    const current = bumpCounter(counters.rpm, keyId, minute, 0);
    if (current + 1 > rpmLimit) {
      return { allowed: false, reason: `Rate limit exceeded: ${rpmLimit} requests per minute`, retryAfterMs: (minute + 1) * 60000 - Date.now() };
    }
  }

  // RPH
  const rphLimit = apiKeyInfo.rph;
  if (rphLimit != null) {
    const hour = getHourTs();
    const current = bumpCounter(counters.rph, keyId, hour, 0);
    if (current + 1 > rphLimit) {
      return { allowed: false, reason: `Rate limit exceeded: ${rphLimit} requests per hour`, retryAfterMs: (hour + 1) * 3600000 - Date.now() };
    }
  }

  // RPD
  const rpdLimit = apiKeyInfo.rpd;
  if (rpdLimit != null) {
    const date = getDateKey();
    const current = bumpCounter(counters.rpd, keyId, date, 0);
    if (current + 1 > rpdLimit) {
      return { allowed: false, reason: `Rate limit exceeded: ${rpdLimit} requests per day`, retryAfterMs: 86400000 - (Date.now() % 86400000) };
    }
  }

  // Max tokens per request
  if (apiKeyInfo.maxTokens != null && tokens > apiKeyInfo.maxTokens) {
    return { allowed: false, reason: `Token limit exceeded: max ${apiKeyInfo.maxTokens} tokens per request` };
  }

  // Daily tokens
  if (apiKeyInfo.maxTokensDaily != null) {
    const date = getDateKey();
    const current = counters.tokensDaily.get(keyId);
    const used = current?.key === date ? current.tokens : 0;
    if (used + tokens > apiKeyInfo.maxTokensDaily) {
      return { allowed: false, reason: `Daily token limit exceeded: ${apiKeyInfo.maxTokensDaily}` };
    }
  }

  // 5-hour rolling tokens
  if (apiKeyInfo.tokens5h != null) {
    const used = getRollingTokenCount(counters.tokens5h, keyId, 5 * 3600000);
    if (used + tokens > apiKeyInfo.tokens5h) {
      return { allowed: false, reason: `5-hour token window exceeded: ${apiKeyInfo.tokens5h}` };
    }
  }

  // Weekly tokens
  if (apiKeyInfo.tokensWeekly != null) {
    const week = getWeekKey();
    const current = counters.tokensWeekly.get(keyId);
    const used = current?.key === week ? current.tokens : 0;
    if (used + tokens > apiKeyInfo.tokensWeekly) {
      return { allowed: false, reason: `Weekly token limit exceeded: ${apiKeyInfo.tokensWeekly}` };
    }
  }

  // Monthly tokens
  if (apiKeyInfo.tokensMonthly != null) {
    const month = getMonthKey();
    const current = counters.tokensMonthly.get(keyId);
    const used = current?.key === month ? current.tokens : 0;
    if (used + tokens > apiKeyInfo.tokensMonthly) {
      return { allowed: false, reason: `Monthly token limit exceeded: ${apiKeyInfo.tokensMonthly}` };
    }
  }

  // Tokens per rolling minute (Go: rateLimitTpm). Distinct from rpm: rpm counts
  // requests, this counts the tokens those requests are allowed to move.
  if (apiKeyInfo.rateLimitTpm != null) {
    const used = getRollingTokenCount(counters.tpm, keyId, 60_000);
    if (used + tokens > apiKeyInfo.rateLimitTpm) {
      return { allowed: false, reason: `Token rate limit exceeded: ${apiKeyInfo.rateLimitTpm} tokens per minute`, retryAfterMs: 60_000 };
    }
  }

  // Simultaneous in-flight requests (Go: rateLimitConcurrency). The slot is
  // taken by acquireApiKeyLease at the gate and given back by
  // recordApiKeyUsage, so a long stream holds its slot for its whole life.
  if (apiKeyInfo.rateLimitConcurrency != null) {
    const live = liveLeases(keyId).length;
    if (live >= apiKeyInfo.rateLimitConcurrency) {
      return { allowed: false, reason: `Concurrency limit exceeded: ${apiKeyInfo.rateLimitConcurrency} simultaneous requests`, retryAfterMs: 1000 };
    }
  }

  return { allowed: true };
}

/**
 * Record request usage against a key's counters.
 * @param {object} apiKeyInfo
 * @param {number} tokensUsed - total tokens consumed (prompt + completion)
 */
export function recordApiKeyUsage(apiKeyInfo, tokensUsed = 0) {
  if (!apiKeyInfo) return;
  const keyId = apiKeyInfo.id;
  const tokens = Math.max(0, Number(tokensUsed) || 0);

  // The request is done: hand its concurrency slot back before anything else,
  // so a rejection below can never strand the slot.
  releaseApiKeyLease(apiKeyInfo);

  bumpCounter(counters.rpm, keyId, getMinuteTs(), 1);
  bumpCounter(counters.rph, keyId, getHourTs(), 1);
  bumpCounter(counters.rpd, keyId, getDateKey(), 1);

  if (tokens > 0) {
    bumpTokens(counters.tokens5h, keyId, tokens);
    bumpTokens(counters.tpm, keyId, tokens);

    const date = getDateKey();
    const daily = counters.tokensDaily.get(keyId);
    if (!daily || daily.key !== date) {
      counters.tokensDaily.set(keyId, { key: date, tokens });
    } else {
      daily.tokens += tokens;
    }

    const week = getWeekKey();
    const weekly = counters.tokensWeekly.get(keyId);
    if (!weekly || weekly.key !== week) {
      counters.tokensWeekly.set(keyId, { key: week, tokens });
    } else {
      weekly.tokens += tokens;
    }

    const month = getMonthKey();
    const monthly = counters.tokensMonthly.get(keyId);
    if (!monthly || monthly.key !== month) {
      counters.tokensMonthly.set(keyId, { key: month, tokens });
    } else {
      monthly.tokens += tokens;
    }
  }
}

/**
 * Get current usage snapshot for a key (for dashboard display).
 * @param {object} apiKeyInfo
 */
export function getApiKeyUsageSnapshot(apiKeyInfo) {
  if (!apiKeyInfo) return null;
  const keyId = apiKeyInfo.id;
  return {
    rpm: { limit: apiKeyInfo.rpm, used: (counters.rpm.get(keyId)?.count || 0) },
    rph: { limit: apiKeyInfo.rph, used: (counters.rph.get(keyId)?.count || 0) },
    rpd: { limit: apiKeyInfo.rpd, used: (counters.rpd.get(keyId)?.count || 0) },
    tokens5h: { limit: apiKeyInfo.tokens5h, used: getRollingTokenCount(counters.tokens5h, keyId, 5 * 3600000) },
    maxTokens: { limit: apiKeyInfo.maxTokens, used: null },
    maxTokensDaily: { limit: apiKeyInfo.maxTokensDaily, used: (counters.tokensDaily.get(keyId)?.tokens || 0) },
    tokensWeekly: { limit: apiKeyInfo.tokensWeekly, used: (counters.tokensWeekly.get(keyId)?.tokens || 0) },
    tokensMonthly: { limit: apiKeyInfo.tokensMonthly, used: (counters.tokensMonthly.get(keyId)?.tokens || 0) },
    rateLimitTpm: { limit: apiKeyInfo.rateLimitTpm, used: getRollingTokenCount(counters.tpm, keyId, 60_000) },
    rateLimitConcurrency: { limit: apiKeyInfo.rateLimitConcurrency, used: liveLeases(keyId).length },
  };
}
