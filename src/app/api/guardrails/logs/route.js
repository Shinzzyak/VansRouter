import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { countGuardrailLogs, listGuardrailLogs, normalizeLimit } from "@/lib/db/repos/guardrailLogRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/guardrails/logs — recent guardrail firings, newest first.
 *
 * Read-only: there is no write endpoint on purpose. Rows are produced by the taps
 * in the request path, so a hand-written entry would be an audit trail that no
 * traffic produced.
 */
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = normalizeLimit(url.searchParams.get("limit"));
  const [logs, total] = await Promise.all([listGuardrailLogs(limit), countGuardrailLogs()]);

  return NextResponse.json({ logs, total, limit });
}
