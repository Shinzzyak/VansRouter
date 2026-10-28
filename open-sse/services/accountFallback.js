import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../config/errorConfig.js";
import {
  getCircuitBreaker,
  getAllCircuitBreakerStatuses,
  resetCircuitBreaker,
  PROVIDER_FAILURE_ERROR_CODES,
} from "../utils/circuitBreaker.js";
import { classify429 } from "../utils/classify429.js";
import { getProviderResilienceProfile } from "../config/providerProfiles.js";
import { isContentFilterMessage } from "../utils/refusalSignals.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
// Statuses that point at the credential, not the request. They are handled by the
// status rules above; listed here so the request-scoped branch never swallows them.
const ACCOUNT_SCOPED_STATUS = new Set([401, 402, 403, 407, 429]);

export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {string|null} provider - provider id, for provider-specific profiles
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number, requestScoped?: boolean }}
 *
 * `shouldFallback` = "is the credential at fault?" (account rotation).
 * `requestScoped` = "did this member reject the request itself?" (combo rotation).
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  // Moderation safety net FIRST: a refusal is a policy verdict regardless of the
  // status it arrives with (500/502 refusals exist) and regardless of whether the
  // exact wording made it into ERROR_RULES. Must run before the status rules, or a
  // 500 refusal would return the transient-cooldown verdict below it.
  if (isContentFilterMessage(errorText)) {
    return { shouldFallback: false, cooldownMs: 0, isContentFilter: true, requestScoped: true };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.shouldFallback === false) {
        return {
          shouldFallback: false,
          cooldownMs: 0,
          ...(rule.isContentFilter && { isContentFilter: true }),
        };
      }
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.shouldFallback === false) {
        return { shouldFallback: false, cooldownMs: 0 };
      }
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped 4xx: the CREDENTIAL is healthy, the REQUEST itself was rejected
  // (validation, unsupported parameter, context overflow). Two different questions
  // share this function: account rotation ("is this credential bad?") and combo
  // rotation ("can this member serve this request?"). For a 4xx the answer is
  // no-account-fault + yes-try-the-next-member. Falling through to the transient
  // default below would both cooldown a healthy account for 30 s and hide the real
  // cause behind a fabricated 503.
  if (status >= 400 && status < 500 && !ACCOUNT_SCOPED_STATUS.has(status)) {
    return { shouldFallback: false, cooldownMs: 0, requestScoped: true };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/**
 * Patterns that indicate a MONTHLY-REFILL provider has exhausted the credits
 * for the current cycle. Kimchi and CodeBuddy both answer this way: the pack
 * refills on its own at the cycle boundary, so the account must be PARKED, not
 * retired. Specific enough to avoid matching "exhausted all retries".
 */
const CYCLICAL_QUOTA_PATTERNS = [
  /credits?.{0,20}exhausted/i,
  /quota.{0,20}exhausted/i,
  /no remaining credits/i,
  /insufficient[ _-]?credits/i,
  /payment.{0,10}required/i,
  /has exhausted its credits/i,
];

/**
 * Providers whose quota is a MONTHLY REFILL rather than a prepaid wallet.
 *
 * The distinction is the whole point: a wallet that hits zero stays empty until
 * a human pays, so deactivating it forever is correct. A refill pack comes back
 * by itself on the cycle boundary, so retiring the account throws away capacity
 * that was going to return for free. Measured 2026-10-22 on CodeBuddy Intl:
 * `{"error":{"data":{"code":14018,"msg":"Credits exhausted…"}}}`, billing
 * showing CycleCapacityUsed 100/100 with CycleEndTime 2026-10-31 — i.e. the pack
 * refills in nine days, yet the connection had been marked dead permanently and
 * the stored reason read "Invalid API key", which is what sent us looking for a
 * broken token that was in fact valid (billing answered 200 with the same key).
 */
export const CYCLICAL_QUOTA_PROVIDERS = new Set(["kimchi", "codebuddy-cn", "codebuddy-intl"]);

/**
 * Detect whether an error body / message indicates cyclical quota exhaustion.
 * @param {string} provider - provider id
 * @param {string|object} errorText - raw error body or message
 * @returns {boolean}
 */
export function isCyclicalQuotaExhausted(provider, errorText) {
  if (!errorText || !CYCLICAL_QUOTA_PROVIDERS.has(provider)) return false;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  return CYCLICAL_QUOTA_PATTERNS.some(p => p.test(text));
}

/**
 * Patterns to detect autoclaw balance exhaustion (points depleted).
 * Error from proxy: {"message":"积分不足,请充值"} (Insufficient points, please recharge).
 * Also match generic insufficient balance patterns.
 */
const AUTOCLAW_BALANCE_EXHAUSTED_PATTERNS = [
  /积分不足/i,
  /insufficient.{0,10}balance/i,
  /insufficient.{0,10}points/i,
  /points?.{0,20}exhausted/i,
];

/**
 * Patterns that mean "this account cannot serve ANY request until someone pays".
 *
 * Distinct from the autoclaw patterns above in one way that matters: this is not
 * provider-specific. A prepaid relay answers the same way whatever its brand, and
 * the wording is the gateway's, not ours — measured 2026-09-22 on the nfh relay
 * (api.inferhub.dev):
 *   {"error":{"message":"balance too low for this request — deposit USDC to continue",
 *             "type":"insufficient_balance"}}
 * That relay was the FIRST candidate of the smart-fallback combo, so every
 * request paid ~7.8s of latency to learn the deposit was empty, 142 times in one
 * window = 64.9 minutes of pure waste, with 72 of those attempts immediately
 * followed by a success on another provider.
 *
 * Why the existing rules never caught it: 402 has a status rule that grants a
 * 2-MINUTE cooldown, which is right for a rate/quota blip and wrong for an empty
 * wallet. A 2-minute lock on a permanent condition means the account is selected
 * again on the very next request.
 */
const PERMANENT_BALANCE_PATTERNS = [
  /insufficient.{0,10}balance/i,
  /balance.{0,20}(too low|exhausted|depleted|empty)/i,
  /(deposit|recharge|top ?up).{0,40}(to continue|required|first)/i,
  /credit.{0,20}(exhausted|depleted)/i,
  /积分不足/i,
];

/**
 * Detect whether an error means the account's balance is exhausted — a condition
 * that persists until a human recharges it.
 *
 * Provider-agnostic on purpose. Used to deactivate the connection instead of
 * giving it a short cooldown it will simply outlive.
 *
 * @param {string|object} errorText
 * @returns {boolean}
 */
export function isPermanentBalanceExhausted(errorText) {
  if (!errorText) return false;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  return PERMANENT_BALANCE_PATTERNS.some(p => p.test(text));
}

/**
 * Detect whether error indicates autoclaw balance exhaustion.
 * @param {string} provider
 * @param {string|object} errorText
 * @returns {boolean}
 */
export function isAutoclawInsufficientBalance(provider, errorText) {
  if (!errorText || provider !== "autoclaw") return false;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  return AUTOCLAW_BALANCE_EXHAUSTED_PATTERNS.some(p => p.test(text));
}

/**
 * Build update payload to deactivate an autoclaw account due to insufficient balance.
 * No auto-reset — points are recharge-based, not monthly. Manual reactivation needed.
 * @returns {{ isActive: boolean, testStatus: string, lastErrorType: string, errorCode: number, balanceExhaustedAt: string }}
 */
export function buildAutoclawBalanceExhaustedUpdate(now = new Date()) {
  return {
    isActive: false,
    testStatus: "insufficient_balance",
    lastErrorType: "insufficient_balance",
    errorCode: 402,
    balanceExhaustedAt: now.toISOString(),
  };
}

/**
 * Compute the next-day reset timestamp (00:00 UTC tomorrow).
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
export function getNextDayReset(now = new Date()) {
  const d = new Date(now.getTime());
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

/**
 * Compute the next month boundary (00:00 UTC on the 1st).
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
export function getNextMonthReset(now = new Date()) {
  const d = new Date(now.getTime());
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Build the update payload that PARKS an account whose monthly pack is spent.
 *
 * testStatus="quota_exhausted" is what the hourly reactivation sweep looks for,
 * so it must survive `markAccountUnavailable` clobbering the row to "unavailable"
 * — chat.js re-asserts this payload after that call for exactly that reason.
 *
 * Reset differs by provider on purpose. CodeBuddy's pack is calendar-monthly
 * (CycleStartTime 1st, CycleEndTime last day), so the reset is the 1st of next
 * month. Kimchi keeps its historical next-day reset: it self-heals either way,
 * and widening this to a month would silently delay a provider that currently
 * recovers within a day.
 *
 * @param {string} provider - provider id
 * @param {Date} [now]
 * @returns {object}
 */
export function buildCyclicalQuotaExhaustedUpdate(provider, now = new Date()) {
  const reset = provider === "kimchi" ? getNextDayReset(now) : getNextMonthReset(now);
  return {
    isActive: false,
    rateLimitedUntil: reset.toISOString(),
    testStatus: "quota_exhausted",
    lastErrorType: "quota_exhausted",
    errorCode: 429,
    // Overwrite the human-readable reason too. The dashboard test path writes
    // "Invalid API key" for anything it cannot verify, which reads as a broken
    // credential and hides a condition that fixes itself.
    lastError: `Credits exhausted for the current cycle; resets ${reset.toISOString()}`,
    quotaExhaustedAt: now.toISOString(),
    quotaResetsAt: reset.toISOString(),
  };
}

/**
 * Build update payload to reactivate a quota-exhausted Kimchi account whose
 * rateLimitedUntil has passed (start of new month).
 * @returns {{ isActive: boolean, rateLimitedUntil: null, testStatus: string }}
 */
export function buildCyclicalQuotaReactivatedUpdate() {
  return {
    isActive: true,
    rateLimitedUntil: null,
    testStatus: "active",
    quotaExhaustedAt: null,
    quotaResetsAt: null,
  };
}

/**
 * Detect whether a NON-Kimchi 429 error indicates a DAILY quota exhaustion
 * ("today's quota", "daily quota exhausted", "reset tomorrow", etc.).
 *
 * This generalizes beyond Kimchi's monthly quota (which keeps its own
 * isCyclicalQuotaExhausted / cycle-boundary parking logic untouched). When a
 * daily quota is detected, the SPECIFIC model on that connection is locked
 * until tomorrow 00:00 UTC via buildDailyQuotaLockUpdate().
 *
 * Returns the classified cooldown info, or null when the error is not a
 * daily-quota 429 (e.g. it's a plain rate_limit or a Kimchi quota).
 *
 * @param {string} provider - provider id
 * @param {string|object} errorText - raw error body or message
 * @returns {{ kind: "daily_quota", cooldownMs: number } | null}
 */
export function detectDailyQuotaExhaustion(provider, errorText) {
  if (!errorText || CYCLICAL_QUOTA_PROVIDERS.has(provider)) return null;
  const text = typeof errorText === "string"
    ? errorText
    : (() => { try { return JSON.stringify(errorText); } catch { return String(errorText); } })();
  // classify429 returns { kind, cooldownMs }. We only act on daily_quota here;
  // quota_exhausted (monthly/billing) is handled separately and rate_limit
  // is handled by the normal account cooldown/backoff path.
  const classification = classify429({ status: 429, body: text, provider });
  if (classification.kind !== "daily_quota") return null;
  return classification;
}

/**
 * Build update payload that locks a SPECIFIC model on a connection until
 * tomorrow 00:00 UTC. The account itself stays active for OTHER models —
 * only the affected model is temporarily unusable.
 *
 * Uses the existing modelLock_${model} flat-field mechanism (same as transient
 * model locks), so no schema changes are needed and isModelLockActive() picks
 * it up automatically.
 *
 * @param {string} model - the model id (without provider prefix)
 * @param {Date} [now=new Date()]
 * @returns {Record<string, string>} partial update object with the model lock key set
 */
export function buildDailyQuotaLockUpdate(model, now = new Date()) {
  if (!model) return {};
  const resetMs = getMsUntilTomorrowMidnightUTC(now);
  const key = getModelLockKey(model);
  return { [key]: new Date(now.getTime() + resetMs).toISOString() };
}

/** Compute ms until next UTC midnight (tomorrow 00:00 UTC). */
function getMsUntilTomorrowMidnightUTC(now = new Date()) {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(tomorrow.getTime() - now.getTime(), 1000);
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}

// ── Provider-level circuit breaker ──────────────────────────────────

/**
 * Check if a provider is currently blocked by the circuit breaker.
 * Proxy-aware: each proxy bucket has its own breaker so one dead proxy
 * doesn't block accounts on a different proxy.
 */
export function isProviderInCooldown(provider, proxyHash = "direct") {
  if (!provider) return false;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  return breaker ? !breaker.canExecute() : false;
}

/**
 * Get remaining retry-after time for a provider breaker (ms).
 * Proxy-aware.
 */
export function getProviderCooldownRemainingMs(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  if (!breaker || breaker.canExecute()) return null;
  const remaining = breaker.getRetryAfterMs();
  return remaining > 0 ? remaining : null;
}

/**
 * Get the circuit breaker state for a provider.
 * Proxy-aware.
 */
export function getProviderBreakerState(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  return breaker?.getStatus?.() ?? null;
}

/**
 * Record a provider failure against the shared circuit breaker.
 * Deduplicates rapid-fire failures from the same connection within 5s.
 * Proxy-aware: failures are attributed to the specific proxy bucket.
 */
const _lastProviderFailure = new Map();
const _dedupMs = 5_000;
const _dedupMaxSize = 10_000; // cap to prevent unbounded growth

/**
 * Clear the provider-failure dedup map. Used by tests and full resets.
 */
export function clearProviderFailureDedup() {
  _lastProviderFailure.clear();
}

export function recordProviderFailure(provider, statusCode, errorText, log, connectionId, proxyHash = "direct") {
  if (!provider) return;

  // A moderation refusal is the provider working correctly. Counting it opens the
  // breaker for every account on this provider: measured threshold is 5 failures,
  // and a relay that answers refusals with HTTP 500 reaches that in five prompts.
  if (isContentFilterMessage(errorText)) return;

  // Deduplicate
  if (connectionId) {
    const dedupKey = `${provider}:${proxyHash}:${connectionId}`;
    const now = Date.now();
    const last = _lastProviderFailure.get(dedupKey);
    if (last && now - last < _dedupMs) return;
    _lastProviderFailure.set(dedupKey, now);
    // Evict oldest entries when over the cap to prevent unbounded memory growth
    if (_lastProviderFailure.size > _dedupMaxSize) {
      const evictCount = Math.floor(_dedupMaxSize / 10);
      const keysToEvict = Array.from(_lastProviderFailure.keys()).slice(0, evictCount);
      for (const key of keysToEvict) _lastProviderFailure.delete(key);
    }
  }

  // Only count failure-eligible status codes
  if (statusCode && !PROVIDER_FAILURE_ERROR_CODES.has(statusCode)) return;

  const profile = getProviderResilienceProfile(provider);
  const breakerKey = `${provider}:${proxyHash}`;
  const breaker = getCircuitBreaker(breakerKey, {
    failureThreshold: profile.providerFailureThreshold,
    failureWindowMs: profile.providerFailureWindowMs,
    resetTimeout: profile.providerCooldownMs,
  });
  if (!breaker) return;
  if (!breaker.canExecute()) return; // already OPEN, skip

  breaker._onFailure({ statusCode, message: errorText });

  if (!breaker.canExecute()) {
    log?.warn?.(`[ProviderFailure] ${breakerKey}: circuit breaker opened after ${breaker.failureCount} failures`);
  }
}

/**
 * Reset the shared provider breaker for a proxy bucket.
 * Proxy-aware.
 */
export function clearProviderFailure(provider, proxyHash = "direct") {
  if (!provider) return;
  resetCircuitBreaker(`${provider}:${proxyHash}`);
}

/**
 * Check if a status code should count toward provider failure threshold.
 */
export function isProviderFailureCode(status) {
  return PROVIDER_FAILURE_ERROR_CODES.has(status);
}

/**
 * Get all providers currently blocked by the circuit breaker.
 */
export function getProvidersInCooldown() {
  return getAllCircuitBreakerStatuses()
    .filter((s) => {
      const breaker = getCircuitBreaker(s.name);
      return Boolean(breaker && !breaker.canExecute());
    })
    .map((s) => ({
      provider: s.name,
      failureCount: s.failureCount,
      cooldownRemainingMs: s.retryAfterMs || null,
      lastFailureAt: s.lastFailureTime,
    }));
}

/**
 * Pipeline gate: returns true if the circuit breaker is OPEN for ALL known proxy
 * buckets of a provider. When true, the request should short-circuit BEFORE any
 * credential lookup — no point querying the DB when every bucket is blocked.
 * If even one proxy bucket can execute, returns false so the credential loop can
 * try accounts on that bucket.
 */
export function isProviderFullyBlocked(provider) {
  if (!provider) return false;
  const all = getAllCircuitBreakerStatuses();
  // Collect breaker names matching this provider: `${provider}:${proxyHash}`
  const providerBreakers = all.filter((s) => {
    const name = s.name || "";
    return name === provider || name.startsWith(`${provider}:`);
  });
  if (providerBreakers.length === 0) return false; // no breakers registered → not blocked
  // Blocked only if EVERY registered bucket is OPEN (canExecute=false)
  return providerBreakers.every((s) => {
    const breaker = getCircuitBreaker(s.name);
    return Boolean(breaker && !breaker.canExecute());
  });
}

/**
 * Get the shortest remaining cooldown across all proxy buckets for a provider.
 * Used to populate Retry-After when the pipeline gate blocks.
 */
export function getProviderShortestCooldownMs(provider) {
  if (!provider) return 0;
  const all = getAllCircuitBreakerStatuses();
  let shortest = Infinity;
  for (const s of all) {
    const name = s.name || "";
    if (name !== provider && !name.startsWith(`${provider}:`)) continue;
    const breaker = getCircuitBreaker(s.name);
    if (breaker && !breaker.canExecute()) {
      const remaining = breaker.getRetryAfterMs();
      if (remaining > 0 && remaining < shortest) shortest = remaining;
    }
  }
  return shortest === Infinity ? 0 : shortest;
}

/**
 * Returns true when an error signals that the entire provider quota
 * is exhausted (not just one account) so the combo router can skip
 * remaining targets from the same provider.
 */
export function isProviderExhaustedReason(result) {
  if (!result) return false;
  const reason = typeof result === "string" ? result : (result.reason || result.error || "");
  const text = typeof reason === "string" ? reason : JSON.stringify(reason);
  // Specific patterns only — avoid false positives on transient errors that
  // happen to contain the word "exhausted" (e.g. "exhausted all retries").
  return /credits?.{0,20}exhausted|quota.{0,20}exhausted|no remaining credits|insufficient.{0,20}credits|payment.{0,10}required|quota.{0,20}exceeded|rate.?limit.{0,20}reached/i.test(text);
}
