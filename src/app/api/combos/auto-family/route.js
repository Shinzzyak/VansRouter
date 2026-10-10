import { NextResponse } from "next/server";
import { rebuildAutoFamilyCombos, usableModelFamilies } from "@/lib/autoCombos.js";

export const dynamic = "force-dynamic";

// POST /api/combos/auto-family — one fallback combo per normalized model family
// across connected providers, so a family (the same model on several providers)
// gets a chain to fall back through. Upserts stable per-family ids.
export async function POST() {
  try {
    const result = await rebuildAutoFamilyCombos();
    return NextResponse.json({ status: "ok", created: result.families, count: result.count });
  } catch (error) {
    console.error("POST /api/combos/auto-family failed:", error);
    return NextResponse.json({ error: "Failed to build family combos" }, { status: 500 });
  }
}

// GET — preview the families a rebuild would create, without writing.
export async function GET() {
  try {
    const groups = await usableModelFamilies();
    return NextResponse.json({ families: groups, count: Object.keys(groups).length });
  } catch (error) {
    console.error("GET /api/combos/auto-family failed:", error);
    return NextResponse.json({ error: "Failed to preview family combos" }, { status: 500 });
  }
}
