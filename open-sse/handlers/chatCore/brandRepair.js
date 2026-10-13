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
  const source = scrubbed?.changed ? scrubbed.text : rawText;

  const integrity = classifyResponse({
    parsed: resp,
    rawText: source,
    requestBody,
    enforceBrand: true,
  });

  // A refusal is attributed, not repaired — stamping our contract onto another
  // model's decline is the K40/K41 failure mode, not a fix.
  if (integrity.refusal) return null;

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

  const needsRepair = [INTEGRITY.MISSING_BRAND, INTEGRITY.MISSING_SEAL].includes(integrity.status);
  const { text: repairedText, repaired } = needsRepair
    ? repairBrandContract(source, false)
    : { text: source, repaired: false };

  // Byte-identical passthrough when neither half has anything to do.
  if (!scrubbed?.changed && (!repaired || !repairedText)) return null;
  const out = repaired && repairedText ? repairedText : source;
  return writeBack(out) ? out : null;
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
