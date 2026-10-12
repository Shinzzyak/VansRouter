import { buildModelsList } from "@/sse/services/allowedModels.js";
import { isValidApiKey, resolveRequestApiKey, extractApiKey, isProviderAllowed, isComboAllowed, isKindAllowed } from "@/sse/services/auth.js";
import { apiKeyRefusal } from "@/sse/services/apiKeyRefusal.js";
import { stripComboPrefix } from "open-sse/services/combo.js";

import { getSettings } from "@/lib/localDb";

const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "video": ["video"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request, { params }) {
  try {
    const { kind } = await params;
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const settings = await getSettings();
    let apiKeyInfo = null;

    const suppliedKey = extractApiKey(request);

    if (settings.requireApiKey) {
      if (!suppliedKey) {
        return Response.json(
          { error: { message: "Missing API key", type: "authentication_error" } },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
      apiKeyInfo = await isValidApiKey(suppliedKey, request);
      if (!apiKeyInfo) {
        // Same diagnosis the chat path gives, so a buyer who gets nothing back
        // is told which of the causes it was.
        const refusal = await apiKeyRefusal(suppliedKey, request);
        return Response.json(
          { error: { message: refusal.message, type: "authentication_error", code: `api_key_${refusal.failure.reason}` } },
          { status: refusal.status, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
    } else if (suppliedKey) {
      // Local mode with a key supplied: honour the key's policy here too, so a
      // restricted key cannot read the whole catalogue through this route. An
      // address-bound key is refused rather than silently ignored.
      const resolved = await resolveRequestApiKey(suppliedKey, request);
      if (resolved.refusal) {
        return Response.json(
          { error: { message: resolved.refusal.message, type: "permission_error", code: "api_key_ip" } },
          { status: resolved.refusal.status, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
      apiKeyInfo = resolved.info;
    }

    if (apiKeyInfo && !kindFilter.some(k => isKindAllowed(apiKeyInfo, k))) {
      return Response.json({ object: "list", data: [] }, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    let data = await buildModelsList(kindFilter);

    if (apiKeyInfo) {
      const allowedOwners = new Map();
      for (const model of data) {
        const isCombo = model.owned_by === "combo";
        const key = isCombo
          ? `combo:${stripComboPrefix(model.id)}`
          : `provider:${model.id.includes("/") ? model.id.split("/")[0] : model.owned_by}`;
        if (!allowedOwners.has(key)) {
          const allowed = isCombo
            ? isComboAllowed(apiKeyInfo, key.slice(6))
            : await isProviderAllowed(apiKeyInfo, key.slice(9));
          allowedOwners.set(key, allowed);
        }
      }
      data = data.filter((model) => {
        const isCombo = model.owned_by === "combo";
        const key = isCombo
          ? `combo:${stripComboPrefix(model.id)}`
          : `provider:${model.id.includes("/") ? model.id.split("/")[0] : model.owned_by}`;
        return allowedOwners.get(key);
      });
    }


    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
