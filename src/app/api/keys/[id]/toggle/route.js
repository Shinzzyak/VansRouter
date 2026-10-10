import { NextResponse } from "next/server";
import { toggleApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// PUT /api/keys/[id]/toggle - Flip isActive, touching nothing else.
// Dedicated endpoint (9router-go parity) so a UI switch cannot accidentally
// clear a limit by sending a partial body through the full update path.
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const result = await toggleApiKey(id);
    if (!result) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error toggling key:", error);
    return NextResponse.json({ error: "Failed to toggle key" }, { status: 500 });
  }
}
