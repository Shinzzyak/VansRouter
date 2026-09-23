import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

/**
 * GET /api/engine/state — what the capability layer has learned.
 *
 * WHY THIS EXISTS. Four engine modules measure live traffic and, before
 * 2026-09-22, all four kept their state in memory with NO way to read it out:
 *
 *   selfMeasuringBypass  which framing level actually works, per model
 *   routeGuardMemory     which routes filter at the transport layer
 *   refusalDrift         per-model integrity drift
 *   voiceCadence         per-model voice drift
 *
 * `grep -rn 'ledgerSnapshot|routeSnapshot|getAllDrift|getCadence' src/app/`
 * returned nothing, so the measurements were write-only: collected, used for one
 * decision, then lost on the next restart. This route is the read side.
 *
 * Auth uses the shared dashboard guard (CLI token OR dashboard session OR
 * requireLogin=false) — same posture as every other dashboard API, not a new
 * auth path. GET only: this is a diagnostic surface, not a control surface.
 */
export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const out = {
    ok: true,
    capturedAt: new Date().toISOString(),
    modules: {},
  };

  // Every read is individually fail-open: a module that is absent (no engine
  // bundle) or throws must not take the whole route down. The `available` flag
  // distinguishes "engine not loaded" from "engine loaded and has learned
  // nothing yet" — two very different diagnoses when a ledger looks empty.
  const load = async (name, path, pick) => {
    try {
      const mod = await import(path);
      out.modules[name] = { available: true, ...pick(mod) };
    } catch (e) {
      out.modules[name] = { available: false, error: e?.message || String(e) };
    }
  };

  await load("engineState", "open-sse/rtk/engineState.js", (m) => ({
    status: m.stateStatus?.() ?? null,
  }));

  await load("selfMeasuringBypass", "open-sse/rtk/selfMeasuringBypass.js", (m) => ({
    // The ledger is what firstLevel() reads back. Empty while requests are
    // flowing means the ledger is not being written — check the sawToolCalls
    // gate in streamingHandler.js.
    ledger: m.ledgerSnapshot?.(50) ?? [],
  }));

  await load("routeGuardMemory", "open-sse/rtk/routeGuardMemory.js", (m) => ({
    routes: m.routeSnapshot?.() ?? null,
  }));

  await load("refusalDrift", "open-sse/rtk/refusalDrift.js", (m) => ({
    drift: m.getAllDrift?.() ?? {},
  }));

  await load("voiceCadence", "open-sse/rtk/voiceCadence.js", (m) => ({
    cadence: m.cadenceSnapshot?.() ?? [],
  }));

  await load("modelImmunityHints", "open-sse/rtk/modelImmunityHints.js", (m) => ({
    hints: m.immunitySnapshot?.() ?? [],
  }));

  return NextResponse.json(out);
}
