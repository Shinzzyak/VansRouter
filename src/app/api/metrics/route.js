import { NextResponse } from "next/server";
import { defaultMetrics } from "@/lib/observ/metrics.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/metrics — Prometheus text exposition of the gateway's metrics.
 *
 * Operator endpoint, so it sits behind dashboard auth alongside the rest of the
 * dashboard API rather than being world-readable. A scrape target points at this
 * path with the dashboard cookie (or the CLI token header).
 */
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return new Response(defaultMetrics.render(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
