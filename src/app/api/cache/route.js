import { NextResponse } from "next/server";
import { defaultCache } from "@/lib/semanticcache/cache.js";

export const dynamic = "force-dynamic";

// Semantic-cache administration (9router-go parity: /api/cache).
//
// GET    /api/cache -> hit/miss/size stats
// DELETE /api/cache -> clear every entry
//
// ?model=<id> on DELETE invalidates one model's entries; ?signature=<key> drops
// a single entry; ?olderThanMs=<n> invalidates everything older than that. All
// are read from the live cache, so the numbers an operator sees are the numbers
// the router is serving from. (9router-go parity: HandleDeleteCache accepts the
// same three.)
export async function GET() {
  try {
    return NextResponse.json({ cache: defaultCache.stats() });
  } catch (error) {
    console.error("GET /api/cache failed:", error);
    return NextResponse.json({ error: "Failed to read cache stats" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const model = searchParams.get("model");
    const signature = searchParams.get("signature");
    const olderThanMs = Number(searchParams.get("olderThanMs") || 0);

    if (model) {
      const removed = defaultCache.invalidateByModel(model);
      return NextResponse.json({ status: "ok", scope: "model", model, removed });
    }
    if (signature) {
      const removed = defaultCache.deleteEntry(signature) ? 1 : 0;
      return NextResponse.json({ status: "ok", scope: "entry", signature, removed });
    }
    if (Number.isFinite(olderThanMs) && olderThanMs > 0) {
      const removed = defaultCache.invalidateOlderThan(olderThanMs);
      return NextResponse.json({ status: "ok", scope: "age", olderThanMs, removed });
    }

    const removed = defaultCache.len();
    defaultCache.clear();
    return NextResponse.json({ status: "ok", scope: "all", removed });
  } catch (error) {
    console.error("DELETE /api/cache failed:", error);
    return NextResponse.json({ error: "Failed to clear cache" }, { status: 500 });
  }
}
