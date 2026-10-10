import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/db/index.js";
import {
  getAllowedModels,
  parseModelAllowlistBody,
  setAllowedModels,
} from "@/lib/db/repos/apiKeyModelAccessRepo.js";

export const dynamic = "force-dynamic";

// Per-API-key model allowlist (9router-go F-7 parity).
//
// GET  /api/keys/[id]/models -> { id, models: [...] }   ([] = no allowlist)
// PUT  /api/keys/[id]/models -> replaces the allowlist in one transaction
//      accepts {"models": ["a","b"]} or a bare ["a","b"]; [] clears it.
//
// Policy only: it decides whether the key MAY reach a model. Routing is the
// engine's business and is never influenced from here.

async function requireKey(id) {
  const apiKey = await getApiKeyById(id);
  if (!apiKey) return { error: NextResponse.json({ error: "API key not found" }, { status: 404 }) };
  return { apiKey };
}

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const { error } = await requireKey(id);
    if (error) return error;

    const models = await getAllowedModels(id);
    return NextResponse.json({ id, models });
  } catch (err) {
    console.error("GET /api/keys/[id]/models failed:", err);
    return NextResponse.json({ error: "failed to read model allowlist" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const { error } = await requireKey(id);
    if (error) return error;

    let body = null;
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
    }

    const parsed = parseModelAllowlistBody(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const models = await setAllowedModels(id, parsed.models);
    return NextResponse.json({ status: "ok", id, models });
  } catch (err) {
    console.error("PUT /api/keys/[id]/models failed:", err);
    return NextResponse.json({ error: "failed to save model allowlist" }, { status: 500 });
  }
}
