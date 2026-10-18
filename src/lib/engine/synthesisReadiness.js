/**
 * Synthesis readiness — the read side of "why is there no rung yet?"
 *
 * The ladder synthesizes a new rung only when a model has tried EVERY built-in
 * level and won none of them (K164), and only when the refusal carried text.
 * Production sat at zero rungs for days with no way to tell whether that meant
 * "nothing refused yet" or "the trigger is broken". A dashboard that says
 * "belum belajar" while the reader is the broken part is a lie (K166).
 *
 * So this function answers the question with numbers, from evidence the engine
 * already reports: per level, was it tried, did it win, and what is still
 * missing before synthesis can fire.
 *
 * Pure on purpose: no imports, no IO, no clock. The caller passes what the
 * route received, so the same inputs always give the same panel.
 */

export const SYNTHESIS_BLOCK = {
  NO_EVIDENCE: "no evidence yet",
  LEVELS_UNUSED: "levels still untried",
  WON: "a level wins — synthesis not needed",
  REFUSAL_UNKNOWN: "all levels burned — needs a refusal with text",
  READY: "trigger conditions met",
};

/**
 * @param {{models?: Array}} ledger  route response: { models: [...] }
 * @param {{levels?: string[]}} opts
 * @returns {{available: boolean, levels: string[], rows: Array, ready: number, models: number}}
 */
export function synthesisReadiness(ledger, opts = {}) {
  const levels = Array.isArray(opts.levels) && opts.levels.length
    ? opts.levels
    : ["T2", "T1", "T3", "T4"];

  const models = Array.isArray(ledger?.models) ? ledger.models : [];
  // `available:false` is not "empty" — the engine bundle was not loaded, so no
  // statement about the trigger can be made at all.
  if (ledger?.available === false) {
    return { available: false, levels, rows: [], ready: 0, models: 0 };
  }

  const rows = models.map((m) => {
    const ev = m?.levels || {};
    const tried = levels.filter((l) => (ev[l]?.tries || 0) > 0);
    const won = levels.filter((l) => (ev[l]?.wins || 0) > 0);
    const missing = levels.filter((l) => (ev[l]?.tries || 0) === 0);
    const burned = missing.length === 0 && won.length === 0;

    let blocked = SYNTHESIS_BLOCK.READY;
    if (!m?.n) blocked = SYNTHESIS_BLOCK.NO_EVIDENCE;
    else if (missing.length) blocked = SYNTHESIS_BLOCK.LEVELS_UNUSED;
    else if (!burned) blocked = SYNTHESIS_BLOCK.WON;
    else blocked = SYNTHESIS_BLOCK.REFUSAL_UNKNOWN;

    return {
      model: m?.model || "(unknown)",
      n: m?.n || 0,
      best: m?.best || null,
      tried: tried.length,
      won: won.length,
      total: levels.length,
      missing,
      burned,
      // "burned" alone does not guarantee a rung: the refusal must carry text.
      // Reported as its own flag so the panel never promises a synthesis it
      // cannot deliver.
      ready: burned,
      blocked,
    };
  }).sort((a, b) => b.n - a.n);

  return {
    available: true,
    levels,
    rows,
    models: rows.length,
    ready: rows.filter((r) => r.ready).length,
  };
}
