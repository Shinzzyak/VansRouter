import { getProviderConnections, validateApiKey, getApiKeyByValueAny, updateProviderConnection, getSettings, getProviderNodeById, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, connectionHealthTier, pickWindowedLru, shouldStampUnavailable, lastUsedOverlay, stampLastUsedOverlay, BALANCED_WINDOW_SIZE, SUSPECT_PROBATION_MS, SMALL_FLEET_RESCUE_MAX_CONNECTIONS, SMALL_FLEET_RESCUE_MAX_WAIT_MS, LAST_USED_FLUSH_DELAY_MS, LAST_USED_FLUSH_MAX_BATCH } from "open-sse/services/accountFallback.js";
import { classify429 } from "open-sse/utils/classify429.js";
import { resolveAntigravityProxyConfig } from "open-sse/utils/proxyFetch.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS, AI_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Re-export the internal-trust gate so handlers can import it alongside the
// other ACL helpers. Implementation lives in internalTrust.js (dependency-light
// + independently unit-tested for exploit resistance).
export { isTrustedInternalRequest } from "./internalTrust.js";

// Per-provider mutex — allows parallel credential selection across different providers
// while preventing races within the same provider's account rotation.
const _providerMutexes = new Map();

// Deferred lastUsedAt persistence for lock-free balanced picks (K273). The pick
// stamps the in-memory overlay synchronously — that is what keeps concurrent
// picks spread across distinct accounts — while the DB write only feeds
// restarts and the dashboard, so it is coalesced here and flushed in the
// background instead of blocking a request before it calls upstream. A failed
// flush is logged and dropped: the overlay still holds the stamp in memory, so
// rotation stays correct until restart.
const _lastUsedDirty = new Map();
let _lastUsedFlushTimer = null;

export function scheduleLastUsedFlush(id, lastUsedAt) {
  if (!id) return;
  _lastUsedDirty.set(id, { lastUsedAt, consecutiveUseCount: 1 });
  if (_lastUsedDirty.size >= LAST_USED_FLUSH_MAX_BATCH) { void flushLastUsed(); return; }
  if (!_lastUsedFlushTimer) {
    _lastUsedFlushTimer = setTimeout(() => { _lastUsedFlushTimer = null; void flushLastUsed(); }, LAST_USED_FLUSH_DELAY_MS);
    if (typeof _lastUsedFlushTimer.unref === "function") _lastUsedFlushTimer.unref();
  }
}

export async function flushLastUsed() {
  if (_lastUsedDirty.size === 0) return;
  const batch = [..._lastUsedDirty.entries()];
  _lastUsedDirty.clear();
  for (const [id, data] of batch) {
    try {
      await updateProviderConnection(id, data);
    } catch (err) {
      log.warn("AUTH", `lastUsed flush failed for ${String(id).slice(0, 8)}: ${err?.message || err}`);
    }
  }
}

export function filterConnectionsForModel(providerId, connections, model, settings = {}) {
  const override = (settings.providerStrategies || {})[providerId] || {};
  if (providerId !== "freebuff" || override.strictModelAssignment !== true || !model) return connections;
  return connections.filter((connection) => {
    const data = connection.providerSpecificData || {};
    const assignedModel = Object.prototype.hasOwnProperty.call(data, "assignedModel")
      ? data.assignedModel
      : (providerId === "freebuff" ? data.freebuffModel : null);
    return assignedModel === model;
  });
}

function isExpiredCredential(connection) {
  if (!connection?.expiresAt) return false;
  const ms = new Date(connection.expiresAt).getTime();
  return Number.isFinite(ms) && ms < Date.now();
}

function getProviderMutex(provider) {
  if (!_providerMutexes.has(provider)) {
    _providerMutexes.set(provider, Promise.resolve());
  }
  return _providerMutexes.get(provider);
}

export function applyProviderProxyOverride(connectionProviderSpecificData = {}, providerOverride = {}) {
  const accountProxy = connectionProviderSpecificData || {};
  const accountPoolId = typeof accountProxy.proxyPoolId === "string"
    ? accountProxy.proxyPoolId.trim()
    : "";
  const hasExplicitAccountProxy =
    (Array.isArray(accountProxy.proxyPoolIds) && accountProxy.proxyPoolIds.length > 0)
    || (accountPoolId.length > 0 && accountPoolId !== "__none__")
    || (accountProxy.connectionProxyEnabled === true && Boolean(accountProxy.connectionProxyUrl))
    || Boolean(accountProxy.vercelRelayUrl);
  const providerPoolId = typeof providerOverride.proxyPoolId === "string"
    ? providerOverride.proxyPoolId.trim()
    : "";

  if (hasExplicitAccountProxy || !providerPoolId || providerPoolId === "__none__") return accountProxy;
  return { ...accountProxy, proxyPoolId: providerPoolId };
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Resolve alias + strategy BEFORE taking any lock (K273). Only round-robin
  // mutates shared sticky state, so only it joins the per-provider chain: a
  // balanced or fill-first pick is lock-free and never queues behind another
  // request's selection. Locking every strategy is what made a burst of
  // requests serialize on a provider whose fleet was already healthy.
  const providerId = resolveProviderId(provider);
  const settings = await getSettings();
  const providerOverride = (settings.providerStrategies || {})[providerId] || {};
  const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
  let resolveMutex = null;
  if (strategy === "round-robin") {
    const currentMutex = getProviderMutex(provider);
    _providerMutexes.set(provider, new Promise(resolve => { resolveMutex = resolve; }));
    await currentMutex;
  }

  try {

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    // UNLESS real connections exist in DB (e.g. opencode with a personal paid key) —
    // real connections always win over the anonymous "public" identity.
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const realConns = await getProviderConnections({ provider: providerId, isActive: true });
      if (realConns.length > 0) {
        log.info("AUTH", `${providerId} | noAuth provider but ${realConns.length} real connection(s) found — using them instead of virtual public identity`);
      } else {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        // Respect targetProxyPoolIds if set; else fall back to all active pools
        const targetIds = Array.isArray(override.targetProxyPoolIds) && override.targetProxyPoolIds.length > 0
          ? override.targetProxyPoolIds
          : null;
        const poolIds = targetIds && targetIds.length > 0
          ? allPools.filter(p => p.proxyUrl && targetIds.includes(p.id)).map(p => p.id)
          : allPools.filter(p => p.proxyUrl).map(p => p.id);
        const scope = `${providerId}::${model || "*"}`;
        pickedId = pickProxyPoolId(poolIds, strategy, providerId, { scope });
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      const selectedPoolIds = strategy !== "none"
        ? (await getProxyPools({ isActive: true })).filter((p) => p.proxyUrl).map((p) => p.id)
        : [];
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          proxyPoolId: resolvedProxy.proxyPoolId || null,
          strictProxy: resolvedProxy.strictProxy === true,
          proxyPoolIds: selectedPoolIds,
          proxyRotationStrategy: strategy,
          proxyPoolScope: `${providerId}::${model || "*"}`,
        },
      };
      }
    }

    let connections = await getProviderConnections({ provider: providerId, isActive: true });
    connections = filterConnectionsForModel(providerId, connections, model, settings);
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    // Named so the small-fleet rescue below can re-derive availability after
    // waiting out a lock, with exactly the same predicate.
    const isAvailable = (c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // A connection whose access token is already expired and that carries no
      // refresh token can never authenticate. Sending it upstream returns a
      // fake 401 that counts toward MAX_CONSECUTIVE_AUTH_FAILURES and aborts the
      // pool walk before a healthy account is reached (seen with 106 such
      // antigravity rows). Skip structurally unusable credentials entirely.
      if (!c.refreshToken && !c.apiKey && isExpiredCredential(c)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    };
    let availableConnections = connections.filter(isAvailable);

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.flatMap(c => { const t = getEarliestModelLockUntil(c); return t ? [t] : []; });
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      let earliest = expiries.length > 0 ? expiries.reduce((a, b) => a < b ? a : b) : null;
      // Small-fleet rescue (K273): every seat is locked, but the fleet is tiny
      // and the earliest lock lifts soon — wait for it instead of failing the
      // request. A lock is a heuristic (a quota window, a transient error); for
      // a 1–8 seat provider one window must not read as a total outage.
      // Retrying at once re-hits the same error immediately, so this waits (a
      // timer, other requests unaffected) and re-derives availability from the
      // same snapshot — lock checks are time-based — then proceeds only if
      // something is actually free. Never rescues Antigravity (its quota cache
      // is authoritative, not a heuristic) or a seat this request already tried.
      if (!isAntigravity && earliest && connections.length <= SMALL_FLEET_RESCUE_MAX_CONNECTIONS) {
        const waitMs = new Date(earliest).getTime() - Date.now();
        if (waitMs <= SMALL_FLEET_RESCUE_MAX_WAIT_MS) {
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
          availableConnections = connections.filter(isAvailable);
          if (availableConnections.length > 0) {
            log.warn("AUTH", `${provider} | small-fleet rescue: waited ${Math.max(0, waitMs)}ms for lock, ${availableConnections.length} account(s) free`);
          } else {
            // The wait freed nothing this request can still use. Drop the stale
            // retryAfter so the fallthrough reports plain unavailability
            // instead of a lock that has already lifted.
            earliest = null;
          }
        }
      }
      if (earliest && availableConnections.length === 0) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          connectionId: earliestConn?.id || null,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      if (availableConnections.length === 0) {
        log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
        return null;
      }
    }

    // Strategy + provider override were resolved before the lock and are
    // reused here (no second settings read).

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = availableConnections.toSorted((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = availableConnections.toSorted((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else if (strategy === "balanced") {
      // Balanced, lock-free (K273): clean accounts serve first — a seat that
      // failed recently and has not proven itself since only serves when no
      // clean seat is available. Inside the tier the pick is a uniform random
      // choice over the least-recently-used window, so load spreads evenly and
      // no seat becomes the deterministic hot spot. The overlay is stamped
      // synchronously (concurrent picks spread across distinct seats instead
      // of piling onto one window while a DB write is in flight) and the DB
      // stamp is deferred + coalesced, so no request waits on a write before
      // calling upstream.
      const now = Date.now();
      const clean = availableConnections.filter(c => connectionHealthTier(c, now, SUSPECT_PROBATION_MS) === 0);
      const tier = clean.length > 0 ? clean : availableConnections;
      connection = pickWindowedLru(tier, BALANCED_WINDOW_SIZE, Math.random, lastUsedOverlay);
      if (connection) {
        stampLastUsedOverlay(connection.id, now);
        scheduleLastUsedFlush(connection.id, new Date(now).toISOString());
      }
    } else {
      // fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const proxyProviderData = applyProviderProxyOverride(
      connection.providerSpecificData,
      providerOverride,
    );
    const psdForProxy = providerId === "freebuff"
      ? { ...proxyProviderData, proxyPoolScope: `${providerId}::${model || ""}` }
      : proxyProviderData?.proxyPoolIds?.length
        ? { ...proxyProviderData, proxyPoolScope: `${providerId}::${model || ""}` }
        : proxyProviderData;
    const resolvedProxy = providerId === "antigravity"
      ? resolveAntigravityProxyConfig(psdForProxy)
      : await resolveConnectionProxyConfig(psdForProxy || {}, connection.id);

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        proxyPoolId: resolvedProxy.proxyPoolId || null,
        noFitPool: resolvedProxy.noFitPool === true,
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, options = {}) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  const isA6 = provider === "a6api" || provider === "a6api-cli";
  if (isA6 && status !== 401 && status !== 402 && status !== 404) {
    shouldFallback = true;
    cooldownMs = 3000; // 3 seconds cooldown for all non-401/402/404 errors
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else if (status === 429) {
    // Use classify429 for all 429 responses so rate_limit, quota_exhausted,
    // and daily_quota get deterministic, semantically correct cooldowns
    // instead of generic exponential backoff. This also prevents the daily
    // quota lock set earlier in the request path from being overwritten with
    // a shorter backoff cooldown.
    const classification = classify429({ status, body: errorText, provider });
    shouldFallback = true;
    cooldownMs = classification.cooldownMs;
    newBackoffLevel = backoffLevel;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  // When the circuit-breaker / loop-guard toggle is OFF, do NOT write a per-account
  // model lock (mirrors chat behavior when the toggle is disabled). We still return
  // shouldFallback so the request falls through to the next account/provider, but we
  // leave the account lock state untouched.
  const disableLock = options && options.disableLock === true;

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";

  if (disableLock) {
    // Toggle OFF: skip the lock write entirely so the account stays usable.
    return { shouldFallback: true, cooldownMs };
  }

  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  const update = {
    ...lockUpdate,
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
  };
  // K273: the "unavailable" label outlives the lock itself, so only a
  // substantial cooldown earns it. A seconds-long transient lock must not brand
  // a healthy seat as dead on the dashboard — that label is what made a full
  // pool of live keys look empty. The lock itself always applies.
  if (shouldStampUnavailable(cooldownMs)) update.testStatus = "unavailable";

  await updateProviderConnection(connectionId, update);

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Source address of the client, as far as the router can tell.
 *
 * The Next.js server exposes no socket peer address to a route handler, so the
 * only attribution available is what a fronting proxy wrote down.
 *
 * Order matters: custom-server.js (the bundled launcher) derives the address
 * from the TCP socket, strips every client-supplied forwarding header and
 * re-adds its own as `x-9r-real-ip`, so that value is unspoofable and wins. The
 * generic headers are the fallback for a plain `next dev`/standalone run with no
 * wrapper, in the usual trust order: left-most x-forwarded-for entry (the
 * original client), then the single-value headers a CDN sets.
 *
 * @returns {string|null} normalized IPv4/IPv6 string, or null when the request
 *   cannot be attributed to an address at all.
 */
export function clientIp(request) {
  const headers = request?.headers;
  const getter = headers?.get;
  if (typeof getter !== "function") return null;
  const derived = getter.call(headers, "x-9r-real-ip");
  if (derived) {
    const value = normalizeIp(String(derived).trim());
    if (value) return value;
  }
  const xff = getter.call(headers, "x-forwarded-for");
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return normalizeIp(first);
  }
  const single = getter.call(headers, "x-real-ip") || getter.call(headers, "cf-connecting-ip");
  return single ? normalizeIp(String(single).trim()) : null;
}

// "::ffff:1.2.3.4" (v4-mapped v6) → "1.2.3.4"; strips a port and brackets.
function normalizeIp(raw) {
  let ip = String(raw).trim();
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]");
    if (close > 0) ip = ip.slice(1, close);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.split(":")[0];
  }
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  return ip.toLowerCase();
}

function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Check whether a key may be used from a given source address.
 *
 * Semantics match the other allow-lists: null/undefined = any address (default,
 * i.e. every key minted before this existed), [] = nowhere, [x] = only x.
 * Entries are plain IPv4 addresses or CIDR blocks ("203.0.113.7",
 * "203.0.113.0/24"). IPv6 entries only match by exact string.
 *
 * An unattributable request (no proxy header at all) is DENIED for a bound key:
 * the alternative is that anyone can shed the binding by dropping a header.
 */
export function isIpAllowed(apiKeyInfo, ip) {
  if (!apiKeyInfo) return true;
  const allowed = apiKeyInfo.allowedIps;
  if (allowed === null || allowed === undefined) return true; // null = any source
  if (!Array.isArray(allowed) || allowed.length === 0) return false; // [] = none
  if (!ip) return false;
  const candidate = normalizeIp(ip);
  const candidateInt = ipv4ToInt(candidate);
  for (const entry of allowed) {
    if (typeof entry !== "string") continue;
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === candidate) return true;
    const slash = rule.indexOf("/");
    if (slash < 0) continue;
    const net = ipv4ToInt(rule.slice(0, slash));
    const bits = Number(rule.slice(slash + 1));
    if (net === null || candidateInt === null) continue;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((net & mask) === (candidateInt & mask)) return true;
  }
  return false;
}

/**
 * Resolve a key without applying the IP allow-list.
 * Used to tell "this secret is bound to other addresses" (refuse, 403) apart
 * from "this secret is dead" (fall through to today's anonymous handling).
 */
export async function resolveApiKeyIgnoringIp(apiKey) {
  if (!apiKey) return null;
  return await validateApiKey(apiKey);
}

/**
 * Validate API key and return key info (including allowedProviders)
 * Returns null if invalid, or the key object if valid
 */
/**
 * Why was this key refused? Diagnosis for the buyer, never authorization.
 *
 * A sold key that lapses, gets disabled, or moves to another address used to
 * come back as "Invalid API key" for all three, which turns every expiry into a
 * support ticket ("my key stopped working"). The reasons are distinguishable at
 * the row level, so say them.
 */
export async function explainApiKeyFailure(apiKey, request = null) {
  if (!apiKey) return { reason: "missing" };
  let info = null;
  try {
    info = await getApiKeyByValueAny(apiKey);
  } catch {
    // A diagnosis lookup must never change the auth outcome: if it fails
    // the caller still gets its 401, just without the precise reason.
    return { reason: "unknown" };
  }
  if (!info) return { reason: "unknown" };
  if (info.isActive !== 1 && info.isActive !== true) {
    return { reason: "disabled", name: info.name };
  }
  if (info.expiresAt) {
    const expiry = new Date(info.expiresAt).getTime();
    if (expiry && expiry <= Date.now()) {
      return { reason: "expired", name: info.name, expiresAt: info.expiresAt };
    }
  }
  if (!isIpAllowed(info, clientIp(request))) {
    return { reason: "ip", name: info.name, allowedIps: info.allowedIps };
  }
  return { reason: "unknown" };
}

/** Buyer-facing message for a failure from explainApiKeyFailure. */
export function apiKeyFailureMessage(failure) {
  switch (failure?.reason) {
    case "missing": return "Missing API key";
    case "disabled": return "API key is disabled";
    case "expired": return `API key expired on ${failure.expiresAt}`;
    case "ip": return "API key is not allowed from this IP address";
    // Cannot tell which of the three it is (key unknown, or the lookup itself
    // failed) — name all three instead of sending the buyer to support blind.
    default: return "Invalid, expired or disabled API key";
  }
}

export async function isValidApiKey(apiKey, request = null) {
  if (!apiKey) return null;
  const info = await resolveApiKeyIgnoringIp(apiKey);
  if (!info) return null;
  // The IP allow-list is part of "is this key usable here", so every caller that
  // resolves a key inherits the gate without a second call site to keep in sync.
  if (!isIpAllowed(info, clientIp(request))) return null;
  return info;
}

/**
 * Check if a provider is allowed for a given API key info object.
 * null = all allowed (default). [] = none allowed. [x] = only x.
 *
 * For openai-compatible / anthropic-compatible / custom-embedding providers
 * (whose ids embed a UUID suffix), the connection's node prefix is also
 * accepted as a match — the UUID-suffixed id is not user-meaningful and
 * /v1/models lists these under their prefix alias.
 */
const _nodePrefixCache = new Map(); // id -> { prefix, expires }
const NODE_PREFIX_CACHE_TTL_MS = 30000;
async function getNodePrefix(providerId) {
  const cached = _nodePrefixCache.get(providerId);
  if (cached && cached.expires > Date.now()) return cached.prefix;
  try {
    const node = await getProviderNodeById(providerId);
    const prefix = node?.prefix || null;
    _nodePrefixCache.set(providerId, { prefix, expires: Date.now() + NODE_PREFIX_CACHE_TTL_MS });
    return prefix;
  } catch {
    _nodePrefixCache.set(providerId, { prefix: null, expires: Date.now() + NODE_PREFIX_CACHE_TTL_MS });
    return null;
  }
}
/**
 * Resolve the key a request presents into the policy it has to honour, in BOTH
 * auth modes.
 *
 * `info` is the key when it is usable here; `refusal` is set when the key exists
 * but is bound to other source addresses. That one failure must not degrade to
 * anonymous access: a client could otherwise shed its binding by presenting the
 * key anyway. Every other failure (unknown, disabled, expired) keeps the caller's
 * existing behaviour, so a listing route stays reachable when it always was.
 */
export async function resolveRequestApiKey(suppliedKey, request = null) {
  if (!suppliedKey) return { info: null, refusal: null };
  const info = await isValidApiKey(suppliedKey, request);
  if (info) return { info, refusal: null };
  const bound = await resolveApiKeyIgnoringIp(suppliedKey);
  if (bound && !isIpAllowed(bound, clientIp(request))) {
    return {
      info: null,
      refusal: { status: 403, message: "API key is not allowed from this IP address" },
    };
  }
  return { info: null, refusal: null };
}

export async function isProviderAllowed(apiKeyInfo, providerIdOrAlias) {
  if (!apiKeyInfo) return true;
  const allowed = apiKeyInfo.allowedProviders;
  if (allowed === null || allowed === undefined) return true; // null = all
  if (!Array.isArray(allowed) || allowed.length === 0) return false; // [] = none
  if (allowed.includes(providerIdOrAlias)) return true;
  const alias = getProviderAlias(providerIdOrAlias);
  if (alias !== providerIdOrAlias && allowed.includes(alias)) return true;
  const resolvedId = resolveProviderId(providerIdOrAlias);
  if (resolvedId !== providerIdOrAlias && allowed.includes(resolvedId)) return true;
  if (isOpenAICompatibleProvider(providerIdOrAlias) || isAnthropicCompatibleProvider(providerIdOrAlias) || isCustomEmbeddingProvider(providerIdOrAlias)) {
    const prefix = await getNodePrefix(providerIdOrAlias);
    if (prefix && allowed.includes(prefix)) return true;
  }
  return false;
}

/**
 * Check if a combo name is allowed for a given API key.
 * null = all allowed (default). [] = none allowed. [x] = only x.
 */
export function isComboAllowed(apiKeyInfo, comboName) {
  if (!apiKeyInfo) return true;
  const name = comboName.startsWith("combo/") ? comboName.slice(6) : comboName;
  const allowed = apiKeyInfo.allowedCombos;
  if (allowed === null || allowed === undefined) return true;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.includes(name);
}

/**
 * Check if a request kind is allowed for a given API key.
 * Kinds: "llm", "embedding", "image", "tts", "stt", "web"
 * null = all allowed (default). [] = none allowed. [x] = only x.
 */
export function isKindAllowed(apiKeyInfo, kind) {
  if (!apiKeyInfo) return true;
  const allowed = apiKeyInfo.allowedKinds;
  if (allowed === null || allowed === undefined) return true; // null = all
  if (!Array.isArray(allowed) || allowed.length === 0) return false; // [] = none
  return allowed.includes(kind);
}

