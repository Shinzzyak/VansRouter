import { buildModelsList } from "@/sse/services/allowedModels.js";
import { isValidApiKey, extractApiKey, isProviderAllowed, isComboAllowed } from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { resolveProviderId, getProviderAlias } from "@/shared/constants/providers.js";


const LLM_KIND = "llm";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request) {
  try {
    const settings = await getSettings();
    let apiKeyInfo = null;

    if (settings.requireApiKey) {
      const apiKey = extractApiKey(request);
      if (!apiKey) {
        return Response.json(
          { error: { message: "Missing API key", type: "authentication_error" } },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
      apiKeyInfo = await isValidApiKey(apiKey);
      if (!apiKeyInfo) {
        return Response.json(
          { error: { message: "Invalid API key", type: "authentication_error" } },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    let data = await buildModelsList([LLM_KIND]);

    if (apiKeyInfo) {
      data = data.filter((model) => {
        // Combo entries don't contain "/" — they use owned_by="combo"
        const isCombo = !model.id.includes("/") && model.owned_by === "combo";
        if (isCombo) {
          return isComboAllowed(apiKeyInfo, model.id);
        }
        const providerAlias = model.id.includes("/") ? model.id.split("/")[0] : model.owned_by;
        return isProviderAllowed(apiKeyInfo, providerAlias);
      });
    }


    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
