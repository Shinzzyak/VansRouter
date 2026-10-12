import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { maskApiKey } from "@/lib/db/helpers/apiKeyMask.js";
import { getRequestDetails, getRequestStatsForApiKey } from "@/lib/db/repos/requestDetailsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/keys/[id]/logs — the traffic a single sold key produced.
//
// requestDetails has carried apiKey/apiKeyName since migration 004 but nothing
// could read it by key, so "how much did buyer #3 actually use?" was answered by
// eyeballing the global detail view. This is that filter, scoped to one key.
//
// Admin-only by placement (dashboardGuard covers /api/keys); the buyer's own
// view stays GET /api/v1/key, which returns policy and usage, not request rows.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10) || 50));

    // One key, two stored spellings: rows written before the writer masked
    // keys hold the plaintext, newer ones the mask. Match both.
    const keyForms = [key.key, maskApiKey(key.key)];
    const [details, stats] = await Promise.all([
      getRequestDetails({ apiKeyAny: keyForms, page, pageSize }),
      getRequestStatsForApiKey(keyForms),
    ]);

    return NextResponse.json({
      keyId: key.id,
      name: key.name,
      keyDisplay: key.keyDisplay,
      // Rollup over whatever observability still retains — a cap exists
      // (observabilityMaxRecords), so this is recent traffic, not a ledger.
      stats,
      pagination: details.pagination,
      details: details.details,
    });
  } catch (error) {
    console.log("Error fetching key logs:", error);
    return NextResponse.json({ error: "Failed to fetch key logs" }, { status: 500 });
  }
}
