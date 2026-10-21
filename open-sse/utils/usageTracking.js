/**
 * Token Usage Tracking - Extract, normalize, estimate and log token usage
 */

import { FORMATS } from "../translator/formats.js";
import { estimateTokens as profileTokens, familyOf } from "../rtk/tokenProfile.js";

// ANSI color codes
export const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

// Buffer tokens to prevent context errors
const BUFFER_TOKENS = 2000;

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Add buffer tokens to usage to prevent context errors
 * @param {object} usage - Usage object (any format)
 * @returns {object} Usage with buffer added
 */
export function addBufferToUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;

  const result = { ...usage };

  // Claude format
  if (result.input_tokens !== undefined) {
    result.input_tokens += BUFFER_TOKENS;
  }

  // OpenAI format
  if (result.prompt_tokens !== undefined) {
    result.prompt_tokens += BUFFER_TOKENS;
  }

  // Calculate or update total_tokens
  if (result.total_tokens !== undefined) {
    result.total_tokens += BUFFER_TOKENS;
  } else if (result.prompt_tokens !== undefined && result.completion_tokens !== undefined) {
    // Calculate total_tokens if not exists
    result.total_tokens = result.prompt_tokens + result.completion_tokens;
  }

  return result;
}

export function filterUsageForFormat(usage, targetFormat) {
  if (!usage || typeof usage !== "object") return usage;

  // Helper to pick only defined fields from usage
  const pickFields = (fields) => {
    const filtered = {};
    for (const field of fields) {
      if (usage[field] !== undefined) {
        filtered[field] = usage[field];
      }
    }
    return filtered;
  };

  // Define allowed fields for each format
  const formatFields = {
    [FORMATS.CLAUDE]: [
      'input_tokens', 'output_tokens', 
      'cache_read_input_tokens', 'cache_creation_input_tokens',
      'estimated'
    ],
    [FORMATS.GEMINI]: [
      'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
      'cachedContentTokenCount', 'thoughtsTokenCount',
      'estimated'
    ],
    [FORMATS.OPENAI_RESPONSES]: [
      'input_tokens', 'output_tokens',
      'input_tokens_details', 'output_tokens_details',
      'estimated'
    ],
    // OpenAI format (default for OPENAI, CODEX, KIRO, etc.)
    default: [
      'prompt_tokens', 'completion_tokens', 'total_tokens',
      'cached_tokens', 'reasoning_tokens',
      'prompt_tokens_details', 'completion_tokens_details',
      'estimated'
    ]
  };

  // Get fields for target format
  let fields = formatFields[targetFormat];
  
  // Use same fields for similar formats
  if (targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.ANTIGRAVITY) {
    fields = formatFields[FORMATS.GEMINI];
  } else if (targetFormat === FORMATS.OPENAI_RESPONSE) {
    fields = formatFields[FORMATS.OPENAI_RESPONSES];
  } else if (!fields) {
    fields = formatFields.default;
  }

  return pickFields(fields);
}

/**
 * Normalize usage object - ensure all values are valid numbers
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", usage?.prompt_tokens);
  assignNumber("completion_tokens", usage?.completion_tokens);
  assignNumber("total_tokens", usage?.total_tokens);
  assignNumber("cache_read_input_tokens", usage?.cache_read_input_tokens);
  assignNumber("cache_creation_input_tokens", usage?.cache_creation_input_tokens);
  assignNumber("cached_tokens", usage?.cached_tokens);
  assignNumber("reasoning_tokens", usage?.reasoning_tokens);

  // Preserve nested details objects for OpenAI format forwarding
  if (usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    normalized.prompt_tokens_details = usage.prompt_tokens_details;
  }
  if (usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    normalized.completion_tokens_details = usage.completion_tokens_details;
  }

  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

/**
 * Canonicalize usage into ONE storage/cost convention so token counts and cost
 * are consistent across providers:
 *   prompt_tokens               = total input INCLUDING cache read + cache creation
 *   cached_tokens               = cache-read portion (subset of prompt_tokens)
 *   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
 *   completion_tokens, reasoning_tokens, total_tokens
 *
 * Discriminator: Claude reports cache_read_input_tokens with a prompt that
 * EXCLUDES cache, so we fold cache into prompt. OpenAI/Gemini report
 * cached_tokens already counted inside prompt, so we pass through. Idempotent:
 * once folded the output carries cached_tokens (not cache_read_input_tokens),
 * so re-running takes the passthrough branch and does not double-add.
 *
 * @param {object} usage - a normalizeUsage()-shaped object
 * @returns {object|null} canonical token object, or null for invalid input
 */
export function canonicalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  const reasoning = num(usage.reasoning_tokens);
  // Fall back to the nested prompt_tokens_details.cache_creation_tokens shape
  // (buildUsage()'s OpenAI-forwarding format) when the top-level field is
  // absent, so callers that pass a buildUsage() object through don't silently
  // drop cache_creation.
  const cacheCreation = num(usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens);

  let prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  let cached;

  // Claude path: prompt excludes cache; cache_read_input_tokens and/or
  // cache_creation_input_tokens are separate. A cache-miss "first write" only
  // carries cache_creation_input_tokens (no cache_read_input_tokens yet), so
  // check both fields — otherwise a first-write request falls through to the
  // OpenAI passthrough branch below and cache_creation never gets folded in.
  // Guard on the absence of `cached_tokens`: our own canonical output always
  // sets that key (even to 0), so re-running canonicalizeUsage on an already-
  // folded result takes the passthrough branch instead of folding again.
  if (usage.cached_tokens === undefined &&
      (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined)) {
    cached = num(usage.cache_read_input_tokens);
    prompt = prompt + cached + cacheCreation;
  } else {
    // OpenAI/Gemini path (or already-canonical input): prompt already includes cached_tokens.
    // Mirror the cacheCreation fallback above: buildUsage() only ever emits the
    // nested prompt_tokens_details.cached_tokens shape, so without this the
    // cache-read count is silently dropped on every buildUsage()-derived usage.
    cached = num(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  }

  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    // Recompute rather than pass through: when the fold branch ran above,
    // an upstream total_tokens (cache-exclusive) would otherwise be stale.
    total_tokens: prompt + completion,
    cached_tokens: cached,
    cache_creation_input_tokens: cacheCreation,
  };
  if (reasoning > 0) result.reasoning_tokens = reasoning;
  return result;
}

/**
 * Check if usage has valid token data
 * Valid = has at least one token field with value > 0
 * Invalid = empty object {}, null, undefined, no token fields, or all zeros
 */
export function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object") return false;

  // Check for any known token field with value > 0
  const tokenFields = [
    "prompt_tokens", "completion_tokens", "total_tokens",  // OpenAI
    "input_tokens", "output_tokens",                        // Claude
    "promptTokenCount", "candidatesTokenCount"              // Gemini
  ];

  for (const field of tokenFields) {
    if (typeof usage[field] === "number" && usage[field] > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Detect a usage object with a provider-reported zero completion count
 * despite real streamed content having been produced.
 *
 * Some providers (e.g. Shiteru / OpenAI-compatible passthrough on large prompts)
 * return a finish chunk like:
 *   {"usage": {"prompt_tokens": 182812, "completion_tokens": 0, "estimated": true}}
 *
 * hasValidUsage() returns true because prompt_tokens > 0, so the caller's
 * "estimate the whole thing from scratch" fallback is skipped — yet
 * completion_tokens is 0 even though the client received real content.
 * Distinct from hasValidUsage(): this only flags the zero-completion-with-
 * content case, so callers can patch just the output side and keep the
 * provider's (usually more accurate) input token count intact.
 *
 * @param {object|null} usage - Usage object (any format)
 * @param {number} totalContentLength - Total length of streamed response content
 * @returns {boolean} true if completion_tokens/output_tokens is a zero that contradicts real content
 */
export function hasZeroCompletionWithContent(usage, totalContentLength = 0) {
  if (!usage || typeof usage !== "object") return false;
  if (!(totalContentLength > 0)) return false;

  const outTokens = usage.completion_tokens ?? usage.output_tokens;
  return typeof outTokens === "number" && outTokens === 0;
}

/**
 * Patch a usage object whose completion/output tokens are zero despite real
 * streamed content, replacing only the output side with an estimate derived
 * from content length. Keeps the provider's prompt/input token count intact
 * (it's usually accurate — only the provider's output estimate failed).
 *
 * @param {object} usage - Usage object with completion_tokens/output_tokens === 0
 * @param {number} totalContentLength - Total length of streamed response content
 * @param {number} [cpt] - chars-per-token for this request; without it the
 *   output side falls back to a flat four, which halves CJK output
 * @returns {object} New usage object with corrected completion/total tokens
 */
export function fixZeroCompletionUsage(usage, totalContentLength, cpt) {
  const estimatedOut = estimateOutputTokens(totalContentLength, cpt);
  const fixed = { ...usage, estimated: true };

  if (fixed.completion_tokens !== undefined) {
    fixed.completion_tokens = estimatedOut;
    const prompt = fixed.prompt_tokens || 0;
    fixed.total_tokens = prompt + estimatedOut;
  }
  if (fixed.output_tokens !== undefined) {
    fixed.output_tokens = estimatedOut;
  }

  return fixed;
}

/**
 * Extract usage from any format (Claude, OpenAI, Gemini, Responses API)
 */
export function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  // Claude format (message_start event): carries input_tokens + cache_read +
  // cache_creation. message_delta later carries only the final output_tokens,
  // so callers must MERGE (mergeUsage), not overwrite, to keep cache counts.
  if (chunk.type === "message_start" && chunk.message?.usage && typeof chunk.message.usage === "object") {
    const u = chunk.message.usage;
    return normalizeUsage({
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens
    });
  }

  // Claude format (message_delta event) - also handles OpenAI format in final chunk
  if (chunk.type === "message_delta" && chunk.usage && typeof chunk.usage === "object") {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0,
      completion_tokens: chunk.usage.completion_tokens || chunk.usage.output_tokens || 0,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
    });
  }

  // OpenAI Responses API format (response.completed or response.done)
  if ((chunk.type === "response.completed" || chunk.type === "response.done") && chunk.response?.usage && typeof chunk.response.usage === "object") {
    const usage = chunk.response.usage;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      prompt_tokens_details: cachedTokens ? { cached_tokens: cachedTokens } : undefined
    });
  }

  // OpenAI format (also covers DeepSeek which uses prompt_cache_hit_tokens)
  if (chunk.usage && typeof chunk.usage === "object" && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.prompt_cache_hit_tokens,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      prompt_tokens_details: chunk.usage.prompt_tokens_details,
      completion_tokens_details: chunk.usage.completion_tokens_details
    });
  }

  // Gemini format (Antigravity)
  // Antigravity wraps usageMetadata inside response: { response: { usageMetadata: {...} } }
  const usageMeta = chunk.usageMetadata || chunk.response?.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    return normalizeUsage({
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      total_tokens: usageMeta.totalTokenCount,
      cached_tokens: usageMeta.cachedContentTokenCount,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    });
  }

  // Ollama NDJSON format (raw from provider, before translation)
  // Ollama sends: {"model":"...","done":true,"prompt_eval_count":N,"eval_count":M}
  if (chunk.done === true && typeof chunk.prompt_eval_count === "number") {
    return normalizeUsage({
      prompt_tokens: chunk.prompt_eval_count || 0,
      completion_tokens: chunk.eval_count || 0,
      total_tokens: (chunk.prompt_eval_count || 0) + (chunk.eval_count || 0)
    });
  }

  return null;
}

// Field-wise max-merge of two usage objects. Anthropic splits usage across
// events: message_start has real input+cache (output is a placeholder 1),
// message_delta has the real cumulative output (input/cache absent). Max keeps
// the meaningful value from each without clobbering. Idempotent for other
// providers that emit a single complete usage object.
export function mergeUsage(prev, next) {
  if (!prev) return next || null;
  if (!next) return prev;
  const merged = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    // typeof NaN === "number" — guard with Number.isFinite so one malformed
    // chunk can't poison the whole accumulation (Math.max(x, NaN) is NaN).
    if (typeof v === "number" && Number.isFinite(v)) {
      merged[k] = Math.max(typeof merged[k] === "number" ? merged[k] : 0, v);
    } else if (v && typeof v === "object") {
      merged[k] = v; // nested details objects: take latest
    }
  }
  return merged;
}

/**
 * Estimate input tokens from request body
 * Calculate total body size for more accurate estimation
 *
 * The whole serialized body is counted, not just `messages`: tool schemas are
 * part of the prompt and a body that carries ten tools is not a small request.
 * The divisor comes from the tokenizer family of the model that will answer,
 * because one ratio for every script is wrong on two axes at once — measured
 * on 390 characters of the same text, `chars/4` overshoots English by 12%,
 * Indonesian by 57%, and undershoots CJK by 52% and emoji by 75%.
 *
 * @param {object} body request body
 * @param {string} [model] the model that will answer; the family is derived from it
 */
export function estimateInputTokens(body, model) {
  if (!body || typeof body !== "object") return 0;

  try {
    // Calculate total body size (includes messages, tools, system, thinking config, etc.)
    const bodyStr = JSON.stringify(body);
    return estimateChars(bodyStr, model);
  } catch (err) {
    // Fallback if stringify fails
    return 0;
  }
}

// chars/4 remains the last resort: without the engine bundle there is no family
// table, and returning zero would be worse than a rough number.
const EST_CHARS_PER_TOKEN = 4;

/**
 * Count tokens in a string at the given model's family rate.
 * Falls back to chars/4 when the profile is absent or its reading is nonsense.
 */
function estimateChars(text, model) {
  if (!text) return 0;
  try {
    const tokens = profileTokens(text, familyOf(model || ""));
    if (Number.isFinite(tokens) && tokens > 0) return tokens;
  } catch {
    // profile unavailable — fall through
  }
  return Math.ceil(String(text).length / EST_CHARS_PER_TOKEN);
}

/**
 * How many characters of this text buy one token, measured rather than assumed.
 * A ratio outside the band is not a tokenizer ratio, it is a broken reading.
 */
function charsPerToken(text, tokens) {
  if (!text || !Number.isFinite(tokens) || tokens <= 0) return EST_CHARS_PER_TOKEN;
  const ratio = text.length / tokens;
  if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 12) return EST_CHARS_PER_TOKEN;
  return ratio;
}

/**
 * The divisor for one request, measured from the request body itself.
 * Exported so the streaming path can patch a provider's zero-completion usage
 * with the same scale it would have used to estimate the whole thing.
 */
export function requestCharsPerToken(body, model) {
  try {
    const bodyStr = JSON.stringify(body);
    return charsPerToken(bodyStr, estimateChars(bodyStr, model));
  } catch {
    return EST_CHARS_PER_TOKEN;
  }
}

/**
 * The divisor for a bare string. Executors that only have the prompt and the
 * answer as text (web scrapers, CLI wrappers) have no request body to measure,
 * so they measure the text they actually have.
 */
export function textCharsPerToken(text, model) {
  if (!text) return EST_CHARS_PER_TOKEN;
  const s = String(text);
  return charsPerToken(s, estimateChars(s, model));
}

/**
 * Estimate output tokens from content length
 * @param {number} contentLength streamed characters
 * @param {number} [cpt] chars-per-token for this request (see estimateUsage)
 */
export function estimateOutputTokens(contentLength, cpt) {
  if (!contentLength || contentLength <= 0) return 0;
  const divisor = Number.isFinite(cpt) && cpt > 0 ? cpt : EST_CHARS_PER_TOKEN;
  return Math.max(1, Math.floor(contentLength / divisor));
}

/**
 * Format usage object based on target format
 * @param {number} inputTokens - Input/prompt tokens
 * @param {number} outputTokens - Output/completion tokens
 * @param {string} targetFormat - Target format from FORMATS
 */
export function formatUsage(inputTokens, outputTokens, targetFormat) {
  // Claude format uses input_tokens/output_tokens
  if (targetFormat === FORMATS.CLAUDE) {
    return addBufferToUsage({ 
      input_tokens: inputTokens, 
      output_tokens: outputTokens, 
      estimated: true 
    });
  }

  // Default: OpenAI format (works for openai, gemini, responses, etc.)
  return addBufferToUsage({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true
  });
}

/**
 * Estimate full usage when provider doesn't return it
 * @param {object} body - Request body for input token estimation
 * @param {number} contentLength - Content length for output token estimation
 * @param {string} targetFormat - Target format from FORMATS constant
 * @param {string} [model] - Model that answered; picks the tokenizer family
 */
export function estimateUsage(body, contentLength, targetFormat = FORMATS.OPENAI, model) {
  // One divisor for both sides. If the prompt is billed at the family rate and
  // the completion at 4, the difference between them is not a measurement, it
  // is an artefact of two scales. The prompt body is the only text we have on
  // this path, so it is what the rate is measured from.
  const inputTokens = estimateInputTokens(body, model);
  const cpt = requestCharsPerToken(body, model);
  return formatUsage(
    inputTokens,
    estimateOutputTokens(contentLength, cpt),
    targetFormat
  );
}

/**
 * Log usage with cache info (green color)
 */
export function logUsage(provider, usage, model = null, connectionId = null, apiKey = null) {
  if (!usage || typeof usage !== "object") return;

  const p = provider?.toUpperCase() || "UNKNOWN";

  // Support both formats:
  // - OpenAI: prompt_tokens, completion_tokens
  // - Claude: input_tokens, output_tokens
  const inTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
  const outTokens = usage?.completion_tokens || usage?.output_tokens || 0;
  const accountPrefix = connectionId ? connectionId.slice(0, 8) + "..." : "unknown";

  let msg = `[${getTimeString()}] 📊 ${COLORS.green}[USAGE] ${p} | in=${inTokens} | out=${outTokens} | account=${accountPrefix}${COLORS.reset}`;

  // Add estimated flag if present
  if (usage.estimated) {
    msg += ` ${COLORS.yellow}(estimated)${COLORS.reset}`;
  }

  // Add cache info if present (unified from different formats)
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens;
  if (cacheRead) msg += ` | cache_read=${cacheRead}`;

  const cacheCreation = usage.cache_creation_input_tokens;
  if (cacheCreation) msg += ` | cache_create=${cacheCreation}`;

  const reasoning = usage.reasoning_tokens;
  if (reasoning) msg += ` | reasoning=${reasoning}`;

  console.log(msg);
}
