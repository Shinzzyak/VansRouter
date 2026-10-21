// PXPIPE: render bulky Claude-format context as dense PNGs via pxpipe-proxy's
// library API (transformAnthropicMessages). Fail-open like every token saver:
// any error/timeout returns { body: null, summary } and leaves the request untouched.
import { FORMATS } from "../translator/formats.js";
import { estimateTokens as profileTokens, familyOf } from "./tokenProfile.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MIN_CHARS = 25000;
// pxpipe's own profitability gate assumes ~4 chars/token. That is only the
// last-resort divisor: the real one is derived per request from the tokenizer
// family, because a single ratio is off by -75% on emoji and +52% on CJK.
const EST_CHARS_PER_TOKEN = 4;

function bodyChars(body) {
  try {
    return JSON.stringify(body)?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * Chars per token for this body's family. Measured on the body itself, so a
 * CJK-heavy or emoji-heavy request does not get the Latin divisor.
 */
function charsPerToken(body, chars, model) {
  let tokens = 0;
  try {
    tokens = profileTokens(JSON.stringify(body), familyOf(model));
  } catch {
    tokens = 0;
  }
  if (!Number.isFinite(tokens) || tokens <= 0) return EST_CHARS_PER_TOKEN;
  const ratio = chars / tokens;
  // Guard the same way the prompt estimator does: a ratio outside this band is
  // not a tokenizer ratio, it is a broken measurement.
  if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 12) return EST_CHARS_PER_TOKEN;
  return ratio;
}

function skipped(reason, extra = {}) {
  return { body: null, summary: { applied: false, reason, ...extra } };
}

// Transform a Claude-format request body through pxpipe. Returns
// { body: <new body object> | null, summary } — body is null when nothing changed.
// opts.transform is injected by the host (src side) so open-sse stays free of
// filesystem/install concerns and remains usable standalone.
export async function compressWithPxpipe(body, { enabled, format, model, minChars, timeoutMs, transform } = {}) {
  if (!enabled) return skipped("disabled");
  if (typeof transform !== "function") return skipped("not_installed");
  if (!body) return skipped("missing_body");
  if (format !== FORMATS.CLAUDE) return skipped("unsupported_format", { detail: format });

  const startedAt = Date.now();
  const originalChars = bodyChars(body);
  const threshold = Number(minChars) > 0 ? Number(minChars) : DEFAULT_MIN_CHARS;
  if (originalChars < threshold) {
    return skipped("below_threshold", { originalChars, threshold });
  }

  try {
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    // transformAnthropicMessages is local CPU work and can't be aborted; race a
    // timer and discard the result if it loses (input body is never mutated).
    const result = await Promise.race([
      transform({
        body: encoded,
        model,
        options: { minCompressChars: threshold },
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), budget)),
    ]);
    if (!result) return skipped("timeout", { originalChars, durationMs: Date.now() - startedAt });
    if (!result.applied) {
      return skipped(result.reason || "passthrough", {
        detail: result.detail,
        originalChars,
        durationMs: Date.now() - startedAt,
      });
    }

    const newBody = JSON.parse(new TextDecoder().decode(result.body));
    const compressedBodyChars = bodyChars(newBody);
    const info = result.info || {};
    const imagedChars = info.compressedChars || 0;
    // The transformed body is BIGGER in bytes (base64 PNGs) but cheaper in tokens:
    // images bill by pixels (Anthropic: pixels/750), not by encoded length. So the
    // after-estimate is remaining-text tokens + image tokens — never chars/4 of the
    // new body. Provider-billed usage recorded per request stays the ground truth.
    const imageTokensEst = info.imageTokens
      || (info.imagePixels ? Math.round(info.imagePixels / 750) : (info.imageCount || 0) * 4761);
    // One divisor for both sides, derived from this request's tokenizer family so
    // the before/after numbers move on the same scale.
    const cpt = charsPerToken(body, originalChars, model);
    const estFromChars = (chars) => Math.round(Math.max(0, chars) / cpt);
    const summary = {
      applied: true,
      reason: "applied",
      originalChars,
      compressedBodyChars,
      imagedChars,
      imageCount: info.imageCount || 0,
      imageBytes: info.imageBytes || 0,
      tokensBeforeEst: info.baselineTokens || estFromChars(originalChars),
      tokensAfterEst: estFromChars(originalChars - imagedChars) + imageTokensEst,
      durationMs: Date.now() - startedAt,
      cacheOwnsControl: result.cache?.ownsCacheControl === true,
    };
    summary.tokensSavedEst = Math.max(0, summary.tokensBeforeEst - summary.tokensAfterEst);
    summary.savedPct = summary.tokensBeforeEst > 0
      ? +((summary.tokensSavedEst / summary.tokensBeforeEst) * 100).toFixed(2)
      : 0;
    return { body: newBody, summary };
  } catch (e) {
    return skipped("transform_error", { detail: e?.message || String(e), originalChars, durationMs: Date.now() - startedAt });
  }
}

export function formatPxpipeLog(summary) {
  if (!summary) return null;
  if (!summary.applied) return null;
  return `imaged ${summary.imagedChars}ch → ${summary.imageCount} image(s) | est ${summary.tokensBeforeEst}→${summary.tokensAfterEst} tokens (-${summary.savedPct}%) | ${summary.durationMs}ms`;
}
