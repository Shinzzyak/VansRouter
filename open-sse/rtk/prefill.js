/**
 * Prefill passthrough (K225).
 *
 * A trailing `assistant` message is a prefill: the upstream must continue it
 * instead of starting a fresh turn. OpenAI-compatible providers only honour
 * that when the body carries a coach flag — DeepSeek wants `prefix: true`,
 * DashScope/Aliyun wants `partial: true`. Without the flag the prefix is
 * silently dropped, so a continuation-style retry looks like a plain prompt and
 * gets refused again. We learned this the hard way: a prefill test against a
 * DeepSeek-family node was refused word-for-word like the un-prefilled prompt.
 */

const FLAG_BY_FAMILY = {
  deepseek: "prefix",
  dashscope: "partial",
  aliyun: "partial",
};

/** Which body flag this provider/model family needs to honour a prefill. */
export function prefillFlag(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  if (p in FLAG_BY_FAMILY) return FLAG_BY_FAMILY[p];
  if (m.includes("deepseek")) return FLAG_BY_FAMILY.deepseek;
  if (m.includes("qwen") || m.includes("dashscope")) return FLAG_BY_FAMILY.dashscope;
  return null;
}

/**
 * Set the prefill flag in place when the conversation ends on an assistant turn.
 * Returns true when a flag was applied — the caller only uses that for logging.
 */
export function applyPrefillFlags(body, { provider, model } = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (messages[messages.length - 1]?.role !== "assistant") return false;
  const flag = prefillFlag(provider, model);
  if (!flag || body[flag] === true) return false;
  body[flag] = true;
  return true;
}
