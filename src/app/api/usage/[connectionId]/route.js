// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

import { refreshAndUpdateCredentials } from "@/lib/services/credentials.js";
export { refreshAndUpdateCredentials };

// ponytail: in-memory TTL cache (per process) for usage responses — the usage
// page fires one live upstream call per connection on every open, which is the
// "load lama" pain. 5-min TTL, force=1 bypasses, stale-while-revalidate: serve
// the cached snapshot instantly and refresh in the background. Swap for a DB
// table if cross-restart persistence ever matters.
const USAGE_TTL_MS = 5 * 60 * 1000;
const usageCache = globalThis.__usageCache || new Map();
globalThis.__usageCache = usageCache;

function getCachedUsage(connectionId) {
  const entry = usageCache.get(connectionId);
  if (!entry) return null;
  return { ...entry, isStale: Date.now() - entry.fetchedAt > USAGE_TTL_MS };
}

function setCachedUsage(connectionId, usage) {
  if (usage?.error) return; // don't cache failures
  usageCache.set(connectionId, { ...usage, fetchedAt: Date.now() });
}

async function fetchUsageLive(connection, proxyOptions, isOAuth, force) {
  // Refresh credentials only for OAuth connections (apikey has no token refresh)
  if (isOAuth) {
    const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = result.connection;
  }

  let usage = await getUsageForProvider(connection, proxyOptions, { force });

  // If provider returned an auth-expired message instead of throwing,
  // force-refresh token and retry once (OAuth only)
  if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
    try {
      const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = retryResult.connection;
      usage = await getUsageForProvider(connection, proxyOptions, { force });
    } catch (retryError) {
      console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
    }
  }
  return usage;
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const force = new URL(request.url).searchParams.get("force") === "1";


    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Stale-while-revalidate: serve the cached snapshot instantly, refresh in
    // the background when older than TTL. force=1 always goes live.
    if (!force) {
      const cached = getCachedUsage(connectionId);
      if (cached) {
        if (!cached.isStale) return Response.json(cached);
        // stale → return it, revalidate in background (never awaited)
        fetchUsageLive(connection, proxyOptions, isOAuth, false)
          .then((fresh) => setCachedUsage(connectionId, fresh))
          .catch((err) => console.warn(`[Usage] bg revalidate ${connection.provider}: ${err.message}`));
        return Response.json({ ...cached, revalidating: true });
      }
    }

    const usage = await fetchUsageLive(connection, proxyOptions, isOAuth, force);
    setCachedUsage(connectionId, usage);
    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
