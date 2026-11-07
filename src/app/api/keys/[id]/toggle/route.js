import { NextResponse } from "next/server";
import { toggleApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// PUT /api/keys/[id]/toggle - Flip isActive, touching nothing else.
// POST also accepted: the resale UI flips with POST and a 405 there killed the
// button outright. 9router-go parity keeps PUT; POST is a plain alias.
export async function PUT(request, { params }) {
  return handleToggle(request, { params });
}

export async function POST(request, { params }) {
  return handleToggle(request, { params });
}

async function handleToggle(request, { params }) {
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
