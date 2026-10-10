import { NextResponse } from "next/server";
import { getDisabledModels, disableModels } from "@/lib/disabledModelsDb";
import { invalidateAllowedModelsCache } from "@/sse/services/allowedModels.js";
import { clearCachedProviderModels } from "@/lib/db/repos/cachedModelsRepo.js";

export const dynamic = "force-dynamic";

// PUT /api/models/disabled/{provider} — replace the disabled-model set for one
// provider (9router-go parity). The provider travels in the path here, which is
// what a dashboard form binds to; the body still carries the ids.
export async function PUT(request, { params }) {
  try {
    const { provider } = await params;
    const body = await request.json();
    const ids = Array.isArray(body?.ids) ? body.ids : Array.isArray(body) ? body : null;
    if (!provider || !ids) {
      return NextResponse.json({ error: "provider (path) and ids[] required" }, { status: 400 });
    }
    if (ids.length > 0) await disableModels(provider, ids);
    invalidateAllowedModelsCache();
    clearCachedProviderModels().catch(() => {});
    return NextResponse.json({ success: true, provider, count: ids.length });
  } catch (error) {
    console.error("PUT /api/models/disabled/[provider] failed:", error);
    return NextResponse.json({ error: "Failed to save disabled models" }, { status: 500 });
  }
}

// GET /api/models/disabled/{provider} — this provider's disabled ids only.
export async function GET(request, { params }) {
  try {
    const { provider } = await params;
    const all = await getDisabledModels();
    return NextResponse.json({ provider, ids: all[provider] || [] });
  } catch (error) {
    console.error("GET /api/models/disabled/[provider] failed:", error);
    return NextResponse.json({ error: "Failed to fetch disabled models" }, { status: 500 });
  }
}
