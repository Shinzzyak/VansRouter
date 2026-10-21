import fs from "node:fs";
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
import { stateStatus, stateFilePath } from "open-sse/rtk/engineState.js";
import { ledgerSnapshot } from "open-sse/rtk/selfMeasuringBypass.js";
import { routeSnapshot } from "open-sse/rtk/routeGuardMemory.js";
import { getAllDrift, getAllDeliveredDrift } from "open-sse/rtk/refusalDrift.js";
import { cadenceSnapshot } from "open-sse/rtk/voiceCadence.js";
import { immunitySnapshot } from "open-sse/rtk/modelImmunityHints.js";
import { calibrationTable, familyOf, estimateTokens } from "open-sse/rtk/tokenProfile.js";

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

/**
 * The in-memory ledger is not the only ledger.
 *
 * This process loads the engine bundle more than once (the chat path and this
 * route resolve the shim through different chunks), so each load owns its own
 * registry and its own in-memory state. Traffic lands in the chat path's copy;
 * this route's copy sits at whatever it hydrated at boot. Measured 2026-10-19:
 * 34 live requests moved the persisted file by 151 records and this route's
 * `total_n` by zero.
 *
 * The persisted file is the union — every instance merges into it on the way
 * out. So the file is the honest answer to "what does the engine know", and the
 * in-memory snapshot stays as the per-instance view. Both are returned, labelled,
 * because silently swapping one for the other would hide the split instead of
 * reporting it.
 */
function readPersisted() {
  try {
    const file = stateFilePath();
    if (!file || !fs.existsSync(file)) return { available: false, error: "state file absent" };
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const smb = Array.isArray(raw.selfMeasuringBypass) ? raw.selfMeasuringBypass : [];
    const rows = smb.map(([model, e]) => ({
      model,
      n: e?.n || 0,
      esc: e?.esc ?? 0,
      pat: e?.pat ?? 0,
      lastExplore: e?.lastExplore ?? 0,
      lastExplorePat: e?.lastExplorePat ?? 0,
      levels: Object.fromEntries(Object.entries(e?.tries || {}).map(([k, v]) => [k, { tries: v }])),
    }));
    rows.sort((a, b) => b.n - a.n);
    return {
      available: true,
      path: file,
      savedAt: raw.savedAt ? new Date(raw.savedAt).toISOString() : null,
      total_n: rows.reduce((s, r) => s + r.n, 0),
      esc_total: rows.reduce((s, r) => s + r.esc, 0),
      pat_total: rows.reduce((s, r) => s + r.pat, 0),
      rows: rows.length,
      // K183 — the whole file, not the top 50 by `n`. A row with `pat > 0` is a
      // route that just proved itself healthy, and those are exactly the rows
      // with a SMALL `n` — so a top-50-by-`n` window cut every one of them out
      // and the dashboard showed `pat 0` on a file holding `pat 4`. Measured
      // 2026-10-20: 111 rows on disk, 50 shipped, zero of the healthy ones
      // visible. The file is bounded by MAX_LEDGER (500), so sending all of it
      // is a few tens of KB, not an unbounded response.
      ledger: rows,
    };
  } catch (e) {
    return { available: false, error: e?.message || String(e) };
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
    // See readPersisted(): the file is the union of every engine instance in this
    // process; `modules` below is this route's own copy.
    persisted: readPersisted(),
    modules: {
      engineState: read(loaded, "engineState", () => ({ status: stateStatus() })),
      selfMeasuringBypass: read(loaded, "selfMeasuringBypass", () => ({
        // The ledger is what firstLevel() reads back. Empty while requests are
        // flowing means the ledger is not being written — check the sawToolCalls
        // gate in streamingHandler.js.
        // K183 — same window bug as readPersisted(): 50 rows by `n` hides every
        // healthy route. Send the instance's whole ledger (bounded by MAX_LEDGER).
        ledger: ledgerSnapshot(500) ?? [],
      })),
      routeGuardMemory: read(loaded, "routeGuardMemory", () => ({ routes: routeSnapshot() ?? null })),
      refusalDrift: read(loaded, "refusalDrift", () => ({ drift: getAllDrift() ?? {} })),
      // The far side of the brand gate: what the client received once the head
      // repair and the seal stamp ran. Same shape as `refusalDrift`, different
      // source — the pair answers "is the model drifting?" and "did the buyer
      // get the product?" separately. See streamingHandler's `onVerdict`.
      refusalDriftDelivered: read(loaded, "refusalDriftDelivered", () => ({ drift: getAllDeliveredDrift() ?? {} })),
      voiceCadence: read(loaded, "voiceCadence", () => ({ cadence: cadenceSnapshot() ?? [] })),
      modelImmunityHints: read(loaded, "modelImmunityHints", () => ({ hints: immunitySnapshot() ?? [] })),
      // TOK1 — what the router believes a token costs, per tokenizer family.
      // `measured` distinguishes a coefficient fitted against live
      // `usage.prompt_tokens` from one seeded out of the family's published
      // behaviour; `factor` is the EWMA correction learned from traffic. Both
      // are needed to read the table honestly: a factor of 1.4 on a seeded
      // family means the seed was 40% optimistic, not that the model changed.
      tokenProfile: read(loaded, "tokenProfile", () => ({ calibration: calibrationTable() ?? [] })),
    },
  });
}
