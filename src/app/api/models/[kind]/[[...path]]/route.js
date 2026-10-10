import { NextResponse } from "next/server";
import { buildModelsList, matchesModelAllowlist } from "@/sse/services/allowedModels.js";
import { isValidApiKey, extractApiKey } from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { lookupModel } from "@/lib/modelLookup.js";

export const dynamic = "force-dynamic";

// GET /api/models/<kind>            → list models of one service kind
// GET /api/models/<provider>/<model> → metadata for one model
//
// 9router-go splits these across HandleModelsByKind and HandleModelLookup; the
// same suffix decides which one answers. Static routes under /api/models
// (info, caps, custom, alias, availability, ...) are matched first by Next, so
// only a genuine kind or model id reaches this file.
const KNOWN_KINDS = ["llm", "image", "embedding", "tts", "stt", "web", "video", "image-to-text"];

async function optionalApiKeyInfo(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return { apiKeyInfo: null, error: null };
  const apiKey = extractApiKey(request);
  if (!apiKey) return { apiKeyInfo: null, error: 401 };
  const apiKeyInfo = await isValidApiKey(apiKey);
  return { apiKeyInfo, error: apiKeyInfo ? null : 401 };
}

export async function GET(request, { params }) {
  try {
    const { kind, path: rest = [] } = await params;
    const suffix = [kind, ...rest].filter(Boolean).join("/");

    if (!suffix) {
      return NextResponse.json({ error: "missing kind or model id" }, { status: 400 });
    }

    if (!rest.length && KNOWN_KINDS.includes(kind)) {
      const models = await buildModelsList([kind], { skipDynamicFetch: true });
      const data = (models || []).map((m) => ({
        id: m.id,
        object: "model",
        kind,
        owned_by: m.owned_by || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : m.id),
        created: m.created || null,
      }));
      return NextResponse.json({ object: "list", kind, count: data.length, data });
    }

    const { apiKeyInfo, error } = await optionalApiKeyInfo(request);
    if (error) {
      return NextResponse.json({ error: "Invalid or missing API key" }, { status: error });
    }

    const result = await lookupModel(suffix, apiKeyInfo);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("GET /api/models/[kind] failed:", error);
    return NextResponse.json({ error: "Failed to resolve model request" }, { status: 500 });
  }
}

// Re-exported so the per-key invariant is testable from this surface too.
export { matchesModelAllowlist };
