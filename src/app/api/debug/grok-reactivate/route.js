// DEBUG: manual trigger for grok-cli reactivation job.
// Gated behind dashboard auth (VR security convention).
import { runGrokCliReactivationTick } from "@/shared/services/grokCliReactivation.js";
import { getProviderConnections } from "@/lib/localDb.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true";

  // Direct DB sanity check
  const all = await getProviderConnections({ provider: "grok-cli", isActive: false });
  console.log("[DebugGrokReactivate] direct DB inactive grok-cli:", all.length);

  const t0 = Date.now();
  console.log("[DebugGrokReactivate] tick started, force=", force);
  try {
    await runGrokCliReactivationTick(undefined, force);
    console.log("[DebugGrokReactivate] tick finished");
    return Response.json({
      ok: true,
      message: "Grok CLI reactivation tick completed",
      durationMs: Date.now() - t0,
    });
  } catch (error) {
    console.error("[DebugGrokReactivate] tick error:", error);
    return Response.json(
      {
        ok: false,
        error: error?.message || String(error),
        durationMs: Date.now() - t0,
      },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({
    message: "POST to /api/debug/grok-reactivate to run reactivation tick",
  });
}
