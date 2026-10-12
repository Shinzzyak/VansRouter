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
        refusalRate: 0,
        brandMiss: 0,
        sealMiss: 0,
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
    r.total = row?.total || 0;
    r.refusalRate = row?.refusalRate || 0;
    r.brandMiss = row?.counts?.missing_brand || 0;
    r.sealMiss = row?.counts?.missing_seal || 0;
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
