import { NextResponse } from "next/server";
import { deleteCustomModel } from "@/models";
import { invalidateAllowedModelsCache } from "@/sse/services/allowedModels.js";
import { clearCachedProviderModels } from "@/lib/db/repos/cachedModelsRepo.js";

export const dynamic = "force-dynamic";

// DELETE /api/models/custom/<providerAlias>/<modelId>[?type=llm]
//
// go-parity path form of the query-string delete. The model id may itself
// contain slashes, so only the FIRST segment is the provider alias.
export async function DELETE(request, { params }) {
  try {
    const { key } = await params;
    const decoded = decodeURIComponent(key || "");
    const slash = decoded.indexOf("/");
    if (slash <= 0 || slash === decoded.length - 1) {
      return NextResponse.json(
        { error: "key must be '<providerAlias>/<modelId>'" },
        { status: 400 }
      );
    }

    const providerAlias = decoded.slice(0, slash);
    const id = decoded.slice(slash + 1);
    const type = new URL(request.url).searchParams.get("type") || "llm";

    await deleteCustomModel({ providerAlias, id, type });
    invalidateAllowedModelsCache();
    clearCachedProviderModels().catch(() => {});
    return NextResponse.json({ success: true, providerAlias, id, type });
  } catch (error) {
    console.log("Error deleting custom model by key:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
