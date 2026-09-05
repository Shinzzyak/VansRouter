import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { fetchModelsFetcherIds } from "@/sse/services/allowedModels.js";

// GET /api/models - Get models with aliases
let modelsPromise = null;
let modelsPromiseAt = 0;
const MODELS_RESPONSE_CACHE_MS = 15000;
let modelsResponse = null;
let modelsRefreshing = false;

export async function GET() {
  try {
    const now = Date.now();
    if (modelsPromise && now - modelsPromiseAt < MODELS_RESPONSE_CACHE_MS) {
      return NextResponse.json(await modelsPromise, { headers: { "Cache-Control": "private, max-age=15, stale-while-revalidate=60" } });
    }
    if (modelsResponse && now - modelsPromiseAt >= MODELS_RESPONSE_CACHE_MS) {
      if (!modelsRefreshing) {
        modelsRefreshing = true;
        modelsPromise = buildModelsResponse()
          .then((payload) => { modelsResponse = payload; modelsPromiseAt = Date.now(); return payload; })
          .catch((error) => { console.log("Background model refresh failed:", error?.message || error); return modelsResponse; })
          .finally(() => { modelsRefreshing = false; });
      }
      return NextResponse.json(modelsResponse, { headers: { "Cache-Control": "private, max-age=15, stale-while-revalidate=60" } });
    }
    modelsPromiseAt = now;
    modelsPromise = buildModelsResponse();
    const payload = await modelsPromise;
    modelsResponse = payload;
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, max-age=15, stale-while-revalidate=60" } });
  } catch (error) {
    modelsPromise = null;
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

async function buildModelsResponse() {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Include dynamic fetcher models for noAuth/passthrough providers (e.g. opencode)
    // so the ACL dialog can list models for providers whose catalog is not static.
    const extra = [];
    const fetcherEntries = await Promise.all(
      Object.entries(AI_PROVIDERS)
        .filter(([, providerInfo]) => providerInfo?.noAuth && providerInfo?.modelsFetcher)
        .map(async ([providerId, providerInfo]) => ({
          providerId,
          providerInfo,
          fetcherIds: await fetchModelsFetcherIds(providerId, providerInfo),
        }))
    );
    for (const { providerId, providerInfo, fetcherIds } of fetcherEntries) {
      if (!fetcherIds.length) continue;
      const providerAlias = getProviderAlias(providerId) || providerInfo.alias || providerId;
      for (const modelId of fetcherIds) {
        const fullModel = `${providerId}/${modelId}`;
        if (models.some((m) => m.fullModel === fullModel)) continue;
        // Resolve capabilities from the static catalog so the UI's capFilter
        // (e.g. vision === true) can include these models. Without this, caps
        // are {} and every capFilter silently hides the whole provider.
        const c = getCapabilitiesForModel(providerId, modelId);
        extra.push({
          provider: providerAlias,
          model: modelId,
          name: modelId,
          fullModel,
          routedModel: `${providerAlias}/${modelId}`,
          alias: modelId,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        });
      }
    }

    return { models: [...models, ...extra] };
  } catch (error) {
    console.log("Error fetching models:", error);
    throw error;
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
