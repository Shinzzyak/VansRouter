import { classifyResponse, repairBrandContract, INTEGRITY } from "../../rtk/responseIntegrity.js";
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

  const integrity = classifyResponse({
    parsed: resp,
    rawText,
    requestBody,
    enforceBrand: true,
  });

  // A refusal is attributed, not repaired — stamping our contract onto another
  // model's decline is the K40/K41 failure mode, not a fix.
  if (integrity.refusal) return null;
  if (![INTEGRITY.MISSING_BRAND, INTEGRITY.MISSING_SEAL].includes(integrity.status)) return null;

  const { text: repairedText, repaired } = repairBrandContract(rawText, false);
  if (!repaired || !repairedText) return null;

  if (resp?.choices?.[0]?.message) {
    resp.choices[0].message.content = repairedText;
  } else if (Array.isArray(resp?.content)) {
    const textBlock = resp.content.find((b) => b?.type === "text");
    if (textBlock) textBlock.text = repairedText;
    else resp.content.push({ type: "text", text: repairedText });
  } else {
    return null;
  }
  return repairedText;
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
