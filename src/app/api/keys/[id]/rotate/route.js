import { NextResponse } from "next/server";
import { rotateApiKey, getApiKeyById, getApiKeyUsageSnapshot } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/keys/[id]/rotate - Mint a replacement secret in place.
// The row keeps its id, limits, allowlists and usage history, so a leaked key
// can be swapped without deleting the record or re-issuing a new key id.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const rotated = await rotateApiKey(id);
    if (!rotated) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const key = await getApiKeyById(id);
    return NextResponse.json({
      key: rotated.key,
      keyDisplay: rotated.keyDisplay,
      record: { ...key, usage: getApiKeyUsageSnapshot(key) },
    });
  } catch (error) {
    console.log("Error rotating key:", error);
    return NextResponse.json({ error: "Failed to rotate key" }, { status: 500 });
  }
}
