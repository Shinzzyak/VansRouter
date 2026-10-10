import { NextResponse } from "next/server";
import { isValidApiKey, extractApiKey } from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { lookupModel } from "@/lib/modelLookup.js";

export const dynamic = "force-dynamic";

// GET /api/models/info?id=<provider>/<model>
//
// Static route, so it wins over the /api/models/<kind> catch-all.
export async function GET(request) {
  try {
    const settings = await getSettings();
    let apiKeyInfo = null;
    if (settings.requireApiKey) {
      const apiKey = extractApiKey(request);
      apiKeyInfo = apiKey ? await isValidApiKey(apiKey) : null;
      if (!apiKeyInfo) {
        return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
      }
    }

    const id = new URL(request.url).searchParams.get("id") || "";
    const result = await lookupModel(id, apiKeyInfo);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("GET /api/models/info failed:", error);
    return NextResponse.json({ error: "Failed to resolve model" }, { status: 500 });
  }
}
