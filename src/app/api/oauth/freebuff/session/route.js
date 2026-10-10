import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { freebuffSessionStatus } from "@/lib/oauth/freebuffSession.js";

export const dynamic = "force-dynamic";

// GET /api/oauth/freebuff/session — current Freebuff seat for one account
// (9router-go parity). Query: ?connectionId=<id> (omit for the first active
// Freebuff connection). Always 200: "no seat" is a state, not a failure.
export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId") || "";
    return NextResponse.json(await freebuffSessionStatus(connectionId));
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read freebuff session" }, { status: 502 });
  }
}
