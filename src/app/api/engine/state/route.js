import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

// STATIC imports, deliberately.
//
// The first version of this route imported the modules DYNAMICALLY, with the
// specifier held in a variable (`await import(path)` inside a helper). Webpack
// cannot resolve a dynamic specifier, so it survived into the built chunk as a
// runtime `import("open-sse/rtk/engineState.js")` — which the standalone server
// cannot resolve from the deploy root. Measured on the live deploy 2026-09-23:
// every module answered `{"available":false,"error":"Cannot find module
// 'open-sse/rtk/engineState.js'"}` while the file sat on disk next to the shims.
//
// Static imports cannot have that failure mode, and nothing is lost: these are
// the generated SHIMS, which are a few hundred bytes each and call
// loadEngine() in a try/catch. Importing one without the bundle is a no-op, not
// an error — the Zero Break Guarantee. Do not convert these back to a dynamic
// import or a path table.
import { isEngineLoaded } from "open-sse/rtk/engineLoader.js";
import { stateStatus } from "open-sse/rtk/engineState.js";
import { ledgerSnapshot } from "open-sse/rtk/selfMeasuringBypass.js";
import { routeSnapshot } from "open-sse/rtk/routeGuardMemory.js";
import { getAllDrift } from "open-sse/rtk/refusalDrift.js";
import { cadenceSnapshot } from "open-sse/rtk/voiceCadence.js";
import { immunitySnapshot } from "open-sse/rtk/modelImmunityHints.js";

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

/**
 * Wrap one reader. A module that throws must not take the whole route down, and
 * `available` has to mean something: with the bundle ABSENT every shim returns
 * its neutral fallback, so an empty ledger and a missing engine would otherwise
 * look identical — the two very different diagnoses this route exists to tell
 * apart.
 */
function read(engineLoaded, name, fn) {
  if (!engineLoaded) return { available: false, error: "engine bundle not loaded (degraded plain-proxy mode)" };
  try {
    return { available: true, ...fn() };
  } catch (e) {
    return { available: true, error: e?.message || String(e) };
  }
}

export async function GET(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loaded = isEngineLoaded();

  return NextResponse.json({
    ok: true,
    capturedAt: new Date().toISOString(),
    engineLoaded: loaded,
    modules: {
      engineState: read(loaded, "engineState", () => ({ status: stateStatus() })),
      selfMeasuringBypass: read(loaded, "selfMeasuringBypass", () => ({
        // The ledger is what firstLevel() reads back. Empty while requests are
        // flowing means the ledger is not being written — check the sawToolCalls
        // gate in streamingHandler.js.
        ledger: ledgerSnapshot(50) ?? [],
      })),
      routeGuardMemory: read(loaded, "routeGuardMemory", () => ({ routes: routeSnapshot() ?? null })),
      refusalDrift: read(loaded, "refusalDrift", () => ({ drift: getAllDrift() ?? {} })),
      voiceCadence: read(loaded, "voiceCadence", () => ({ cadence: cadenceSnapshot() ?? [] })),
      modelImmunityHints: read(loaded, "modelImmunityHints", () => ({ hints: immunitySnapshot() ?? [] })),
    },
  });
}
