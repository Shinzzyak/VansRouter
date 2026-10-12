import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { explainApiKeyFailure, apiKeyFailureMessage } from "./auth.js";

/**
 * The refusal for a key that isValidApiKey rejected: the HTTP status plus the
 * wording the buyer reads, in one place, so every handler (chat, embeddings,
 * images, speech, videos, search, fetch, systemone) refuses the same key the
 * same way instead of all saying "Invalid API key" for three different causes.
 *
 * Lives in its own module on purpose. Handlers import it directly, and it is
 * defensive: a diagnosis that fails (lookup down, or a test that mocks the auth
 * module and therefore has no explainApiKeyFailure) must never turn a 401 into
 * a 500 — it falls back to the generic three-cause message.
 */
export async function apiKeyRefusal(apiKey, request = null) {
  let failure;
  try {
    failure = await explainApiKeyFailure(apiKey, request);
  } catch {
    return {
      failure: { reason: "unknown" },
      status: HTTP_STATUS.UNAUTHORIZED,
      message: "Invalid, expired or disabled API key",
      code: "api_key_unknown",
    };
  }
  return {
    failure,
    status: failure?.reason === "ip" ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.UNAUTHORIZED,
    message: apiKeyFailureMessage(failure),
    // The status map turns every 403 into "insufficient_quota", which is the
    // wrong thing to tell a buyer whose key is merely bound to another address.
    code: `api_key_${failure?.reason || "unknown"}`,
  };
}
