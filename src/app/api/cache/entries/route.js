import { NextResponse } from "next/server";
import { defaultCache } from "@/lib/semanticcache/cache.js";

export const dynamic = "force-dynamic";

// GET /api/cache/entries — paginated, searchable view of what is cached
// (9router-go parity). Read-only: entries are removed through /api/cache.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get("page") || 1);
    const limit = Number(searchParams.get("limit") || 20);
    const search = searchParams.get("search") || "";
    const model = searchParams.get("model") || "";
    const sortBy = searchParams.get("sortBy") || "created_at";
    const sortOrder = searchParams.get("sortOrder") || "desc";

    const result = defaultCache.listEntries({ page, limit, search, model, sortBy, sortOrder });
    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/cache/entries failed:", error);
    return NextResponse.json({ error: "Failed to list cache entries" }, { status: 500 });
  }
}
