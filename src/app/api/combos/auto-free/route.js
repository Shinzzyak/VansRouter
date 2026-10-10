import { NextResponse } from "next/server";
import { rebuildAutoFreeCombo, AUTO_FREE_COMBO_ID } from "@/lib/autoCombos.js";

export const dynamic = "force-dynamic";

// POST /api/combos/auto-free — (re)build the free-tier fallback combo from the
// live catalog. Upserts a stable row, so calling it twice does not pile up
// copies. Rebuilding replaces operator edits to that row, which is why it is an
// explicit button and never a side effect of a connection change.
export async function POST() {
  try {
    const result = await rebuildAutoFreeCombo();
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
    if (error?.status === 409) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("POST /api/combos/auto-free failed:", error);
    return NextResponse.json({ error: "Failed to build free-tier combo" }, { status: 500 });
  }
}

// GET — preview what a rebuild would produce, without writing.
export async function GET() {
  try {
    const { freeTierComboModels } = await import("@/lib/autoCombos.js");
    const models = await freeTierComboModels();
    return NextResponse.json({ id: AUTO_FREE_COMBO_ID, models, count: models.length });
  } catch (error) {
    console.error("GET /api/combos/auto-free failed:", error);
    return NextResponse.json({ error: "Failed to preview free-tier combo" }, { status: 500 });
  }
}
