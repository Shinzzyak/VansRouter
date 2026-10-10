import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { drainCompressionEvents } from "open-sse/rtk/analytics.js";
import { getCompressionSummary, recordCompressionEvents } from "@/lib/db/repos/compressionAnalyticsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/analytics/compression?since=24h|7d|30d|all
//
// Drains the in-process token-saver events into the kv aggregates first, so the
// response always reflects everything the proxy has seen since the last read.
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await recordCompressionEvents(drainCompressionEvents());
    const { searchParams } = new URL(request.url);
    const summary = await getCompressionSummary(searchParams.get("since") || "24h");
    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    console.log("Error reading compression analytics:", error);
    return NextResponse.json({ error: "Failed to read compression analytics" }, { status: 500 });
  }
}
