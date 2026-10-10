import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

// Port-compat alias for the Go router's POST /api/usage/detail (body: {id}).
// The dashboard's primary surface stays GET /api/usage/request-details/[id].
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }

    const id = body?.id;
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "detail not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error("[API] Failed to get request detail:", error);
    return NextResponse.json({ error: "Failed to fetch detail" }, { status: 500 });
  }
}
