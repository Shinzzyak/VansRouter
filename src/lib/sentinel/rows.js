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
  }

  // Drifted first — the whole point of the column is that a drifted model is not
  // something you have to scroll to find. Then by how much traffic it carries.
  return [...byModel.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "DRIFT" ? -1 : 1;
    if (a.total !== b.total) return b.total - a.total;
    return a.model.localeCompare(b.model);
  });
}
