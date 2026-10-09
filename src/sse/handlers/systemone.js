import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  isProviderAllowed,
  isKindAllowed,
  isTrustedInternalRequest,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { isModelAllowed } from "../services/allowedModels.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import { errorResponse, unavailableResponse, withSelectedConnectionHeader } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { sanitizeSecrets } from "open-sse/handlers/videoCore.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import * as log from "../utils/logger.js";

// System One (v1m / Jev) is a decision-engine lane: state + questions in, a
// calibrated verdict out. No chat translation layer, so the body is forwarded
// as-is with only `model` normalised to the bare id.
const DEFAULT_SYSTEMONE_PROVIDER = "v1m";

// Only rotate accounts for errors upstream rejects BEFORE doing work
// (auth/quota). A 5xx may have already consumed the evaluation.
const ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);

async function requireValidApiKey(request) {
  const settings = await getSettings();
  const trustedInternal = await isTrustedInternalRequest(request);
  if (trustedInternal || !settings.requireApiKey) return { apiKeyInfo: null };

  const apiKey = extractApiKey(request);
  if (!apiKey) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
  const apiKeyInfo = await isValidApiKey(apiKey);
  if (!apiKeyInfo) return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
  return { apiKeyInfo };
}

async function resolveSystemoneProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_SYSTEMONE_PROVIDER, model: null };

  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for System One") };
  }
  if (!modelStr.includes("/")) {
    return { provider: DEFAULT_SYSTEMONE_PROVIDER, model: modelStr };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

/**
 * POST /v1/systemone — calibrated decision-engine pass-through.
 * Body: { state, questions, model? } — see the v1m registry entry.
 */
export async function handleSystemone(request) {
  const auth = await requireValidApiKey(request);
  if (auth.error) return auth.error;

  let parsed;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const resolved = await resolveSystemoneProvider(parsed);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  if (!isKindAllowed(auth.apiKeyInfo, "systemone")) {
    return errorResponse(HTTP_STATUS.FORBIDDEN, "System One requests are not allowed for this API key");
  }
  if (!(await isProviderAllowed(auth.apiKeyInfo, provider))) {
    return errorResponse(HTTP_STATUS.FORBIDDEN, `Provider "${provider}" is not allowed for this API key`);
  }
  if (model && !(await isModelAllowed(`${provider}/${model}`, auth.apiKeyInfo))) {
    return errorResponse(
      HTTP_STATUS.NOT_FOUND,
      `Model "${provider}/${model}" is not available. Only models listed in /v1/models can be used.`
    );
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        return unavailableResponse(
          lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE,
          `[${provider}/${model || "systemone"}] ${lastError || credentials.lastError || "Unavailable"}`,
          credentials.retryAfter,
          credentials.retryAfterHuman
        );
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshed = await checkAndRefreshToken(provider, credentials);

    const result = await handleSystemoneCore({
      body: parsed,
      modelInfo: { provider, model },
      credentials: refreshed,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) {
      log.info("SYSTEMONE", `${provider.toUpperCase()} | ${model || "systemone"} ok (connection ${credentials.connectionId})`);
      return withSelectedConnectionHeader(result.response, credentials.connectionId);
    }

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      sanitizeSecrets(result.error, refreshed),
      provider,
      model
    );

    if (shouldFallback && ROTATION_STATUSES.has(result.status)) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
