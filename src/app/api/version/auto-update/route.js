import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { getSettings, updateSettings } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";

export const dynamic = "force-dynamic";

// POST /api/version/auto-update  { enabled }
//
// The preference is persisted even on a pack build (which has no npm channel to
// update from): the operator's intent survives a rebuild, and the updater
// simply has nothing to act on. Reporting the effective channel keeps that
// honest instead of implying an update will happen.
export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  try {
    await updateSettings({ autoUpdate: body.enabled });
    const settings = await getSettings();
    return NextResponse.json({
      ok: true,
      autoUpdate: settings.autoUpdate === true,
      updateChannel: UPDATER_CONFIG.updateChannel,
      effective: settings.autoUpdate === true && UPDATER_CONFIG.updateChannel === "npm",
    });
  } catch (error) {
    console.error("POST /api/version/auto-update failed:", error);
    return NextResponse.json({ error: "Failed to save auto-update preference" }, { status: 500 });
  }
}
