// K260 — direct mode had no second model.
//
// Combo/smart-fallback owns model rotation, and combo is exactly what the owner
// said to stop assuming: "anggep aja kita ga pake smart fallback atau combo,
// direct ke model yang ada di router". On that path a refusal arrives, the
// genome ladder burns its rungs on the SAME node, and then chatCore hands the
// refusal to the client — there is no rung left that is a different model.
//
// Measured on tiprouter 2026-10-28, eight models, one authorized-pentest task:
//   deepseek-v4.1-flash  NOLAK     ("I can't write this one. ...")
//   glm-5-3-flash        NOLAK     ("I'm not going to write this. ...")
//   step-3.7-flash       answered
// So the refusal is NOT uniform across models: a second model is the correct
// next move, and the ladder's job (resample the same model) is already spent by
// the time we get here.
//
// ORDER MATTERS — the ladder first, the model second:
//   1. resample the same model with a new frame (genome)
//   2. same model, DIFFERENT NODE (provider-prompt wall, K257/K258)
//   3. different model (this file)
// Swapping the model first would hide a provider-prompt finding and pay a
// quality change for something a node rotation fixes.
//
// CONFIG — one settings key, `refusalFallbackChain`:
//   ["m2", "m3"]            applied to every direct model, in order
//   { "m1": ["m2"] }        per-model chains; unknown models get nothing
// Unset = feature off. Nothing here runs unless the owner configures it.

/** Hard cap on how many models one request may try. Rotation is a cost. */
export const MAX_FALLBACK_MODELS = 3;

/**
 * Models to try after `model` refuses, in order, deduped, never `model` itself.
 * @param {string} model
 * @param {object|null|undefined} settings
 * @returns {string[]}
 */
export function fallbackChainFor(model, settings) {
  const cfg = settings?.refusalFallbackChain;
  if (!cfg || typeof model !== "string" || !model) return [];
  let list;
  if (Array.isArray(cfg)) list = cfg;
  else if (typeof cfg === "object") list = cfg[model];
  else return [];
  if (!Array.isArray(list)) return [];
  const seen = new Set([model]);
  const out = [];
  for (const m of list) {
    if (typeof m !== "string") continue;
    const s = m.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_FALLBACK_MODELS) break;
  }
  return out;
}

/**
 * The one call the handler needs: given what already failed, what is next?
 * @param {string[]} tried — models already attempted for this request
 * @param {object|null|undefined} settings
 * @returns {string|null}
 */
export function nextFallbackModel(tried, settings) {
  if (!Array.isArray(tried) || !tried.length) return null;
  const primary = tried[0];
  for (const candidate of fallbackChainFor(primary, settings)) {
    if (!tried.includes(candidate)) return candidate;
  }
  return null;
}
