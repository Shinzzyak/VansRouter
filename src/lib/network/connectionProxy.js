import { getProxyPoolById } from "@/models";
import { fitPoolIds } from "open-sse/services/proxyPoolFitness.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

// NOTE: pickProxyPoolId is defined at the bottom of this file as
// pickProxyPoolIdFromActive (handles both MIBP opts shape and noAuth
// targetProxyPoolIds array shape). The MIBP-era standalone implementation
// was merged into it to avoid duplicate exports.

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Multi-Proxy Pool (new format with rotation)
 * 2. Single Proxy Pool (legacy)
 * 3. Legacy Proxy
 * 4. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {},
  connectionId = null,
  excludePoolIds = null
) {
  try {
    // Handle new multi-proxy format
    const proxyPoolIds = providerSpecificData?.proxyPoolIds || [];
    const proxyRotationStrategy = providerSpecificData?.proxyRotationStrategy || "none";

    // Handle legacy single-proxy format
    const legacyProxyPoolId = normalizeString(providerSpecificData?.proxyPoolId);
    const proxyPoolIdRaw = legacyProxyPoolId === "__none__" ? "" : legacyProxyPoolId;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Multi-Proxy Pool Resolution (NEW)
     * -----------------------------
     */
    if (proxyPoolIds.length > 0) {
      const scope = providerSpecificData?.proxyPoolScope || null;
      const selectedPoolId = pickProxyPoolId(proxyPoolIds, proxyRotationStrategy, connectionId, { scope, excludeIds: excludePoolIds });

      if (selectedPoolId) {
        const proxyPool = await getProxyPoolById(selectedPoolId);
        const proxyUrl = normalizeString(proxyPool?.proxyUrl);
        const noProxy = normalizeString(proxyPool?.noProxy);

        const isValidPool = proxyPool && proxyPool.isActive === true && proxyUrl;

        if (isValidPool) {
          /**
           * Vercel/Cloudflare relay proxies use base URL rewriting
           * instead of HTTP_PROXY environment variables.
           */
          if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
            return {
              source: proxyPool.type,
              proxyPoolId: selectedPoolId,
              proxyPool,
              connectionProxyEnabled: false,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              strictProxy: proxyPool.strictProxy === true,
              vercelRelayUrl: proxyUrl,
            };
          }

          /**
           * Standard proxy pool
           */
          return {
            source: "pool",
            proxyPoolId: selectedPoolId,
            proxyPool,
            connectionProxyEnabled: true,
            connectionProxyUrl: proxyUrl,
            connectionNoProxy: noProxy,
            strictProxy: proxyPool.strictProxy === true,
          };
        }
      }
    }

    /**
     * -----------------------------
     * Single Proxy Pool Resolution (LEGACY)
     * -----------------------------
     */
    if (proxyPoolIdRaw) {
      const proxyPool = await getProxyPoolById(proxyPoolIdRaw);
      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);
      const isValidPool = proxyPool && proxyPool.isActive === true && proxyUrl;

      if (isValidPool) {
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          return {
            source: proxyPool.type,
            proxyPoolId: proxyPoolIdRaw,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,
            strictProxy: proxyPool.strictProxy === true,
            vercelRelayUrl: proxyUrl,
          };
        }

        return {
          source: "pool",
          proxyPoolId: proxyPoolIdRaw,
          proxyPool,
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,
          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolIdRaw || null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolIdRaw || null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

/**
 * Stable djb2 hash for short string fingerprints (non-cryptographic).
 */
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Compute a stable proxy bucket key for an account.
 * Groups accounts by the proxy they share so the semaphore and circuit
 * breaker can isolate failures per proxy.
 * @param {object} providerSpecificData
 * @returns {string} "direct" if no proxy, "proxy-<hash>" if explicit proxy, "pool-<hash>" if proxy pool
 */
export function getProxyHash(providerSpecificData = {}) {
  const enabled = providerSpecificData?.connectionProxyEnabled === true;
  const url = enabled ? normalizeString(providerSpecificData?.connectionProxyUrl) : "";
  if (url) return `proxy-${djb2(url)}`;
  const poolId = normalizeString(providerSpecificData?.proxyPoolId);
  if (poolId) return `pool-${djb2(poolId)}`;
  return "direct";
}

/**
 * Stable djb2-based pool hash — used to group accounts by multi-proxy rotation
 * selection when proxyPoolIds is set.
 */
export function getProxyPoolHash(providerSpecificData = {}) {
  const poolIds = Array.isArray(providerSpecificData?.proxyPoolIds) ? providerSpecificData.proxyPoolIds : [];
  if (poolIds.length === 0) return getProxyHash(providerSpecificData);
  return `pool-${djb2(poolIds.join(","))}`;
}

// In-memory counters for round-robin / fill-first proxy pool rotation.
// Keyed by `${providerId}:${strategy}:${poolIds}` so different providers,
// strategies, and selected pool subsets keep independent cursors.
const _poolCursors = new Map();

function normalizeTargetPoolIds(targetProxyPoolIds) {
  if (!Array.isArray(targetProxyPoolIds)) return [];
  return [...new Set(targetProxyPoolIds.map(normalizeString).filter(Boolean))];
}

export function filterTargetProxyPoolIds(poolIds, targetProxyPoolIds = []) {
  if (!Array.isArray(poolIds) || poolIds.length === 0) return [];
  const targets = normalizeTargetPoolIds(targetProxyPoolIds);
  if (targets.length === 0) return poolIds;
  const allowed = new Set(targets);
  return poolIds.filter((id) => allowed.has(id));
}

/**
 * Pick a proxy pool id from active pool ids using the configured strategy.
 *
 * Supports two call shapes:
 * 1. MIBP multi-proxy: pickProxyPoolId(poolIds, strategy, connectionId, { scope, excludeIds })
 * 2. 0.9.91 noAuth:    pickProxyPoolId(poolIds, strategy, providerId, targetProxyPoolIds[])
 *
 * @param {string[]} poolIds active proxy pool ids
 * @param {string} strategy rotation strategy
 * @param {string} providerId provider/connection id for cursor isolation
 * @param {string[]|object} targetProxyPoolIdsOrOpts optional subset or opts object
 * @returns {string|null} chosen pool id, or null when pool/subset is empty
 */
export function pickProxyPoolIdFromActive(poolIds, strategy, providerId = "", targetProxyPoolIdsOrOpts = []) {
  let eligiblePoolIds = poolIds;
  let scope = null;
  let excludeIds = [];

  if (targetProxyPoolIdsOrOpts && typeof targetProxyPoolIdsOrOpts === "object" && !Array.isArray(targetProxyPoolIdsOrOpts)) {
    // MIBP shape: opts = { scope, excludeIds }
    scope = targetProxyPoolIdsOrOpts.scope || null;
    excludeIds = targetProxyPoolIdsOrOpts.excludeIds || [];
  } else {
    // 0.9.91 shape: array of target pool ids
    eligiblePoolIds = filterTargetProxyPoolIds(poolIds, targetProxyPoolIdsOrOpts);
    if (eligiblePoolIds.length === 0) return null;
  }

  eligiblePoolIds = eligiblePoolIds.filter((id) => !excludeIds.includes(id));
  if (strategy === "smart" && scope) eligiblePoolIds = fitPoolIds(eligiblePoolIds, scope);

  if (eligiblePoolIds.length === 0) {
    eligiblePoolIds = poolIds.filter((id) => !excludeIds.includes(id));
    if (eligiblePoolIds.length === 0) return null;
  }
  if (eligiblePoolIds.length === 1) return eligiblePoolIds[0];

  const strat = String(strategy || "").toLowerCase();

  if (strat === "round-robin" || strat === "smart") {
    const key = `${providerId}:${strat}:${eligiblePoolIds.join(",")}`;
    const idx = (_poolCursors.get(key) ?? 0) % eligiblePoolIds.length;
    _poolCursors.set(key, (idx + 1) % eligiblePoolIds.length);
    return eligiblePoolIds[idx];
  }

  if (strat === "random") {
    return eligiblePoolIds[Math.floor(Math.random() * eligiblePoolIds.length)];
  }

  if (strat === "fill-first") return eligiblePoolIds[0];

  return eligiblePoolIds[0];
}

// Alias: MIBP callers use pickProxyPoolId with opts shape; noAuth callers use
// pickProxyPoolId with targetProxyPoolIds array. Both land here.
export const pickProxyPoolId = pickProxyPoolIdFromActive;

export const __test__ = { rotateState, djb2, normalizeTargetPoolIds };
