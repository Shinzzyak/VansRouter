// Folds the per-model windows of GET /api/engine/state into one status row each.
//
// Kept out of the component (which is JSX, and therefore unimportable from the
// node-environment test suite) so the derivation can be tested against a real
// payload shape instead of being asserted on as text.
//
// The three windows are produced by the engine and served verbatim by the route:
//   refusalDrift.drift[model]  -> { total, refusalRate, drifted, counts:{ missing_brand, missing_seal, ... } }
//   voiceCadence.cadence[]     -> { model, avgScore, window, drifted }
//   selfMeasuringBypass.ledger[] -> { model, n, wins, best, last }
// A model is DRIFT when either window says so; otherwise OK.
//
// `last` is "<tier>/<class>" — the escalation level and the class the engine's
// own classifier gave the last reply. That class is the only place the FILTER
// axis lives: whether the request actually got through the model's own filter
// or died on it. This module is where that axis is named, so the component
// stays a renderer.
const FILTER_TONE = {
  PATUH: "open",           // answered under the owner identity: filter passed
  NOLAK: "blocked",        // explicit refusal text
  FILTER_UPSTREAM: "blocked", // provider-side filter killed it
  SENYAP: "warn",          // empty / silent reply — no text to judge
  SUBSTITUSI: "warn",      // answered something else
  AMBIGU: "warn",
  INFRA: "unknown",        // transport/provider error, not a filter verdict
};

/** Split "<tier>/<class>" (or a bare class) into its two halves. */
export function splitOutcome(last) {
  const raw = typeof last === "string" ? last.trim() : "";
  if (!raw) return { tier: "", outcome: "" };
  const slash = raw.lastIndexOf("/");
  if (slash === -1) return { tier: "", outcome: raw.toUpperCase() };
  return { tier: raw.slice(0, slash), outcome: raw.slice(slash + 1).toUpperCase() };
}

/** The filter verdict for one model, from the engine's last outcome class. */
export function filterVerdict(outcome) {
  if (!outcome) return { filter: "—", tone: "unknown" };
  return { filter: outcome, tone: FILTER_TONE[outcome] || "unknown" };
}

export function sentinelRows(modules) {
  const drift = modules?.refusalDrift?.drift || {};
  const cadence = modules?.voiceCadence?.cadence || [];
  const ledger = modules?.selfMeasuringBypass?.ledger || [];

  const byModel = new Map();
  const ensure = (model) => {
    if (!model) return null;
    if (!byModel.has(model)) {
      byModel.set(model, {
        model,
        status: "OK",
        total: 0,
        ok: 0,
        refused: 0,
        empty: 0,
        refusalRate: 0,
        brandViolationRate: 0,
        enclosureViolationRate: 0,
        brandMiss: 0,
        sealMiss: 0,
        enclosureMiss: 0,
        driftAxes: [],
        best: "",
        last: "",
        cadenceScore: null,
        tier: "",
        outcome: "",
        filter: "—",
        filterTone: "unknown",
      });
    }
    return byModel.get(model);
  };

  for (const [model, row] of Object.entries(drift)) {
    const r = ensure(model);
    if (!r) continue;
    const c = row?.counts || {};
    r.total = row?.total || 0;
    r.ok = c.ok || 0;
    r.refused = c.refusal_text || 0;
    r.empty = c.empty || 0;
    r.refusalRate = row?.refusalRate || 0;
    r.brandViolationRate = row?.brandViolationRate || 0;
    r.enclosureViolationRate = row?.enclosureViolationRate || 0;
    r.brandMiss = c.missing_brand || 0;
    r.sealMiss = c.missing_seal || 0;
    r.enclosureMiss = c.missing_enclosure || 0;
    // Which axis tripped. The engine names them; an engine older than the
    // axis-aware version sends none, and the row must still read DRIFT from
    // its `drifted` flag rather than quietly going green.
    r.driftAxes = Array.isArray(row?.driftAxes) ? row.driftAxes : [];
    if (row?.drifted) r.status = "DRIFT";
  }

  for (const row of cadence) {
    const r = ensure(row?.model);
    if (!r) continue;
    r.cadenceScore = row?.avgScore ?? null;
    if (row?.drifted) r.status = "DRIFT";
  }

  for (const row of ledger) {
    const r = ensure(row?.model);
    if (!r) continue;
    r.best = row?.best || "";
    r.last = row?.last || "";
    const { tier, outcome } = splitOutcome(r.last);
    r.tier = tier;
    r.outcome = outcome;
    const verdict = filterVerdict(outcome);
    r.filter = verdict.filter;
    r.filterTone = verdict.tone;
  }

  // Drifted first — the whole point of the column is that a drifted model is not
  // something you have to scroll to find. Then by how much traffic it carries.
  return [...byModel.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "DRIFT" ? -1 : 1;
    if (a.total !== b.total) return b.total - a.total;
    return a.model.localeCompare(b.model);
  });
}

/**
 * The whole-window total the tiles need, from the same rows the table renders.
 *
 * WHY THIS EXISTS. The tab showed a per-model table and six tiles that counted
 * MODELS (172 watched, 0 drifted, …). Nothing summed the judged replies, so the
 * tab could say "DRIFTED 0" in green while 45% of all replies had lost the brand
 * line — the two numbers lived in different units and the eye read the green
 * one. `broken` and `contractOk` are the same data in the unit that matters.
 *
 * `contractOk` is null, not 1, when nothing has been judged: an empty window is
 * not a healthy one, and a tile must not paint it green.
 */
export function sentinelTotals(rows) {
  const t = { models: rows.length, drifted: 0, judged: 0, ok: 0, refused: 0, empty: 0, brandMiss: 0, sealMiss: 0, enclosureMiss: 0, broken: 0, contractOk: null };
  for (const r of rows) {
    if (r.status === "DRIFT") t.drifted++;
    t.judged += r.total || 0;
    t.ok += r.ok || 0;
    t.refused += r.refused || 0;
    t.empty += r.empty || 0;
    t.brandMiss += r.brandMiss || 0;
    t.sealMiss += r.sealMiss || 0;
    t.enclosureMiss += r.enclosureMiss || 0;
  }
  t.broken = t.brandMiss + t.sealMiss + t.enclosureMiss;
  if (t.judged) t.contractOk = Math.max(0, (t.judged - t.broken) / t.judged);
  return t;
}
