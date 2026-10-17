import { classifyResponse, repairBrandContract, INTEGRITY } from "../../rtk/responseIntegrity.js";
import { scrubSelfDescriptionLab } from "../../rtk/selfDescriptionScrub.js";
import { TOKEN_SAVER_HEADER } from "../../config/runtimeConfig.js";

/**
 * One definition of "the chat surface needs the brand/seal contract enforced".
 *
 * There are two non-streaming exits in chatCore: the true non-streaming handler
 * and the forced-SSE→JSON re-assembler used by providers flagged
 * `forceStream: true`. Before this module existed the repair was wired into the
 * first only, so a reply assembled on the second path was returned with the
 * brand line the model happened to write and no seal (measured: 10/10
 * brand-bearing bodies from a forceStream provider carried no seal, 7/7 from a
 * non-forceStream provider carried it). Two copies of the same predicate is the
 * exact shape that already caused the ring/ledger drift incident — hence one
 * helper, both call sites.
 *
 * The contract is deliberately NOT applied to structured output: a validator
 * (JSON schema, delegation harness) fails on a contract-compliant answer, so
 * appending the brand line corrupts instead of fixes.
 *
 * @param {object} resp      response object as returned to the client
 * @param {string} rawText   the visible text extracted from `resp`
 * @param {object} opts      { requestBody, personaExempt, clientRawRequest }
 * @returns {string|null}    repaired text, or null when nothing changed
 */
export function enforceChatBrand(resp, rawText, { requestBody, personaExempt, clientRawRequest } = {}) {
  if (personaExempt) return null;
  if (clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() === "off") return null;
  if (!rawText || !rawText.trim()) return null;

  // K99, output half. This is the NON-STREAMING twin of the stream gate's scrub: a
  // provider fronted by a web UI carries its own page context ("you are GLM by Z.ai"),
  // and no prompt of ours outranks it, so the identity answer arrives as
  // "Saya GLM, model bahasa besar yang dikembangkan oleh Z.ai." with our contract
  // already intact. Measured live on this exact path after the stream-gate scrub
  // shipped — which is why the scrub runs BEFORE the integrity gate below: a
  // contract-complete reply classifies as OK and would return early, leak and all.
  const scrubbed = scrubSelfDescriptionLab(rawText);
  // K121 (measured 2026-10-17 in the default profile's own log, message 249940).
  // A model that has the brand contract stated three times in its prompt can
  // stutter it: line 1 clean, line 2 "MADE BY: GEFREITER — GEFREITER — AGENT OF
  // AVRES". Both lines pass a `startsWith` test, so every downstream guard called
  // the body fine and the buyer read two headers. Dedupe before classification so
  // the integrity gate sees the body the caller will actually get.
  const deduped = collapseDuplicateBrand(scrubbed?.changed ? scrubbed.text : rawText);
  const source = deduped.text;

  const writeBack = (text) => {
    if (resp?.choices?.[0]?.message) {
      resp.choices[0].message.content = text;
      return true;
    }
    if (Array.isArray(resp?.content)) {
      const textBlock = resp.content.find((b) => b?.type === "text");
      if (textBlock) textBlock.text = text;
      else resp.content.push({ type: "text", text });
      return true;
    }
    return false;
  };

  const integrity = classifyResponse({
    parsed: resp,
    rawText: source,
    requestBody,
    enforceBrand: true,
  });

  // A refusal is attributed, not repaired — stamping our contract onto another
  // model's decline is the K40/K41 failure mode, not a fix. The LAB SCRUB is not
  // part of the contract: it only removes the lab's name from text the caller is
  // about to read, so it is written back BEFORE this gate returns. Measured live
  // 2026-10-17 (JustAsk H14 "thats_not_all"): the refusal path returned null and the
  // caller received "I'm GLM, made by Z.ai." — the scrub had already been computed
  // and was thrown away by this early return.
  if (integrity.refusal) {
    // K119b (measured 2026-10-17, H14 run 7). A refusal that ALREADY carries our brand is
    // OUR answer declining part of the request, not another model's decline. Half a
    // contract is worse than either complete state: the buyer reads the brand line, looks
    // for the seal, and finds nothing. Complete the contract on the body that already
    // claimed it; leave a foreign refusal untouched (K40/K41 still stand).
    if (source.trimStart().startsWith("MADE BY: GEFREITER")) {
      const { text: completed, repaired } = repairBrandContract(source, false);
      if (repaired && completed && writeBack(completed)) return completed;
    }
    return (scrubbed?.changed || deduped.changed) && writeBack(source) ? source : null;
  }

  const needsRepair = [INTEGRITY.MISSING_BRAND, INTEGRITY.MISSING_SEAL].includes(integrity.status);
  const { text: repairedText, repaired } = needsRepair
    ? repairBrandContract(source, false)
    : { text: source, repaired: false };

  // Byte-identical passthrough when neither half has anything to do.
  if (!scrubbed?.changed && !deduped.changed && (!repaired || !repairedText)) return null;
  const out = repaired && repairedText ? repairedText : source;
  return writeBack(out) ? out : null;
}

/**
 * Collapse a stuttered brand line (K121).
 *
 * Only the first four lines are inspected: a brand line further down is content
 * (a quoted example, a code block) and must survive untouched. The first
 * brand-shaped line wins; later ones in that window are dropped, and the
 * "GEFREITER — GEFREITER" stutter inside the survivor is normalised.
 *
 * @param {string} text
 * @returns {{text: string, changed: boolean}}
 */
export function collapseDuplicateBrand(text) {
  if (typeof text !== "string" || !text) return { text, changed: false };
  const lines = text.split("\n");
  let seen = false;
  let changed = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isBrand = /^MADE BY:\s*GEFREITER\b/.test(lines[i].trim());
    if (isBrand && i < 4) {
      if (seen) { changed = true; continue; }
      seen = true;
      const fixed = lines[i].replace(/GEFREITER\s+—\s+GEFREITER/g, "GEFREITER");
      if (fixed !== lines[i]) changed = true;
      out.push(fixed);
      continue;
    }
    out.push(lines[i]);
  }
  return { text: changed ? out.join("\n") : text, changed };
}

/** Visible text of a non-streaming response, either shape. */
export function visibleTextOf(resp) {
  const fromChoices = resp?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string") return fromChoices;
  if (Array.isArray(resp?.content)) {
    return resp.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
  }
  return "";
}
