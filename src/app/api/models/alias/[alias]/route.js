import { NextResponse } from "next/server";
import { deleteModelAlias } from "@/models";
import { invalidateAllowedModelsCache } from "@/sse/services/allowedModels.js";
import { clearCachedProviderModels } from "@/lib/db/repos/cachedModelsRepo.js";

// Port-compat alias for the Go router's DELETE /api/models/alias/{alias}.
// The query-param form (DELETE /api/models/alias?alias=) stays the primary surface.
export async function DELETE(_request, { params }) {
  try {
    const { alias } = await params;
    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);
    invalidateAllowedModelsCache();
    clearCachedProviderModels().catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
