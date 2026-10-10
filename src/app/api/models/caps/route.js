import { NextResponse } from "next/server";
import { buildModelsList } from "@/sse/services/allowedModels.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { isFreeTierModelId } from "@/lib/autoCombos.js";

export const dynamic = "force-dynamic";

const ALL_KINDS = ["llm", "image", "embedding", "tts", "stt", "web", "video"];

// GET /api/models/caps — the capability matrix for every model this instance
// can serve (9router-go parity). This is what a buyer's UI reads to decide
// whether a model supports tools / vision / reasoning before calling it, so the
// answer must come from the same capability source the router itself consults.
//
// ?kind=llm narrows to one service kind. ?id=alias/model narrows to one entry.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const kindParam = searchParams.get("kind");
    const idParam = searchParams.get("id");

    const kinds = kindParam ? [kindParam] : ALL_KINDS;
    const models = await buildModelsList(kinds, { skipDynamicFetch: true });

    let entries = (models || []).map((m) => {
      const id = m.id;
      const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : m.owned_by || "";
      const model = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
      return {
        id,
        owned_by: m.owned_by || provider,
        kind: m.kind || "llm",
        // The same free-tier convention the auto-free combo uses (":free" /
        // "-free" / "/free" on the tail of the id) — one rule, one place.
        free: isFreeTierModelId(id),
        capabilities: getCapabilitiesForModel(provider, model),
      };
    });

    if (idParam) entries = entries.filter((e) => e.id === idParam);

    return NextResponse.json({ object: "list", count: entries.length, data: entries });
  } catch (error) {
    console.error("GET /api/models/caps failed:", error);
    return NextResponse.json({ error: "Failed to build capability matrix" }, { status: 500 });
  }
}
