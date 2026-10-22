import * as log from "../utils/logger.js";

/**
 * Build update payload to reactivate a quota-exhausted Kimchi account whose
 * rateLimitedUntil has passed (start of new month).
 * Inlined from open-sse/services/accountFallback.js so this instrumentation
 * path does not pull in the provider registry (which imports Node built-ins).
 */
function buildKimchiQuotaReactivatedUpdate() {
  return {
    isActive: true,
    rateLimitedUntil: null,
    testStatus: "active",
    quotaExhaustedAt: null,
    quotaResetsAt: null,
  };
}

/**
 * Providers whose quota refills on its own at a cycle boundary. MUST match
 * CYCLICAL_QUOTA_PROVIDERS in open-sse/services/accountFallback.js — that module
 * cannot be imported here (it drags circuitBreaker/classify429 into the Next
 * instrumentation compilation, and this path deliberately stays dependency-free),
 * so the list is duplicated and `tests/unit/cyclical-quota-park.test.js` fails if
 * the two ever diverge.
 */
export const CYCLICAL_PROVIDERS = ["kimchi", "codebuddy-cn", "codebuddy-intl"];

/**
 * Reactivate monthly-refill connections whose quota was exhausted and whose
 * `rateLimitedUntil` has now passed (i.e. a new cycle has started).
 *
 * Queries deactivated ("quota_exhausted") connections for every cyclical
 * provider and, for each whose cooldown timestamp is in the past, restores it to
 * an active state. Errors per-account are caught and logged so a single failure
 * does not abort the whole sweep.
 *
 * @returns {Promise<number>} count of accounts reactivated this run
 */
export async function reactivateExpiredKimchiAccounts() {
  // webpackIgnore prevents Next.js dev from bundling better-sqlite3 (and its
  // Node built-in deps) into the instrumentation compilation. The relative path
  // is required because webpackIgnore also disables @ alias resolution.
  const { getProviderConnections, updateProviderConnection } = await import(
    /* webpackIgnore: true */
    "../../lib/localDb.js"
  );

  let connections = [];
  for (const provider of CYCLICAL_PROVIDERS) {
    try {
      const rows = await getProviderConnections({ provider, isActive: false });
      if (rows?.length) connections.push(...rows);
    } catch (e) {
      log.warn("AUTH", `Quota reactivation: failed to query connections for ${provider}: ${e.message}`);
    }
  }

  if (connections.length === 0) return 0;

  const now = Date.now();
  let reactivated = 0;

  for (const conn of connections) {
    // Only reactivate accounts previously marked as quota-exhausted.
    if (conn.testStatus !== "quota_exhausted") continue;

    // No cooldown timestamp → nothing to compare against; skip defensively.
    if (!conn.rateLimitedUntil) continue;

    const untilMs = new Date(conn.rateLimitedUntil).getTime();
    // Cooldown not yet expired — wait for the new month.
    if (Number.isNaN(untilMs) || untilMs > now) continue;

    try {
      await updateProviderConnection(conn.id, buildKimchiQuotaReactivatedUpdate());
      reactivated++;
      log.info("AUTH", `Quota reactivated: ${conn.provider || "?"} ${conn.name || conn.id} (cooldown expired ${conn.rateLimitedUntil})`);
    } catch (e) {
      log.warn("AUTH", `Quota reactivation failed for ${conn.name || conn.id}: ${e.message}`);
    }
  }

  if (reactivated > 0) {
    log.info("AUTH", `Quota reactivation: ${reactivated} account(s) reactivated`);
  }
  return reactivated;
}
