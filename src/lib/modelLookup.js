// Single-model metadata lookup, shared by GET /api/models/info?id= and
// GET /api/models/<provider>/<model> (9router-go's HandleModelsInfo and
// HandleModelLookup).
//
// One implementation because the two URLs answer the same question, and because
// the per-key allowlist check has to happen in exactly one place: a key that
// cannot dispatch a model must not be able to probe its metadata either.

import { getModelInfo } from "@/sse/services/model.js";
import { matchesModelAllowlist } from "@/sse/services/allowedModels.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

export async function lookupModel(modelId, apiKeyInfo = null) {
  const id = String(modelId || "").trim();
  if (!id) {
    return { status: 400, body: { error: "missing id query parameter" } };
  }

  if (!matchesModelAllowlist(id, apiKeyInfo)) {
    return {
      status: 403,
      body: { error: { message: `model not allowed for this API key: ${id}`, code: "model_not_allowed" } },
    };
  }

  let info;
  try {
    info = await getModelInfo(id);
  } catch {
    info = null;
  }
  if (!info || !info.provider) {
    return { status: 404, body: { error: `model not found: ${id}` } };
  }

  const caps = getCapabilitiesForModel(info.provider, info.model || id);
  return {
    status: 200,
    body: {
      id,
      object: "model",
      provider: info.provider,
      model: info.model || id,
      owned_by: info.provider,
      context_length: caps.contextWindow ?? null,
      max_output_tokens: caps.maxOutput ?? null,
      capabilities: caps,
    },
  };
}
