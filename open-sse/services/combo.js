/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { DEFAULT_COMBO_TARGET_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { getRoleAdapterModel, stripHistoryForContext } from "./capacityAdapter.js";
import { extractTextContent } from "../translator/formats/gemini.js";

// Strip "combo/" prefix from model string (e.g. "combo/coding-stack" → "coding-stack")
export function stripComboPrefix(modelStr) {
  if (typeof modelStr !== "string") return modelStr;
  return modelStr.startsWith("combo/") ? modelStr.slice(6) : modelStr;
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}
// Flatten ONLY orphan `tool` messages (no preceding assistant tool_calls).
// Keeps legitimate tool_calls intact so the executor can still run tools.
function flattenOrphanToolMessages(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const isTool = msg.role === "tool" || msg.role === "function";
    if (isTool) {
      const toolId = msg.tool_call_id;
      const hasPrecedingCall = toolId
        ? out.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c?.id === toolId))
        : out.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
      if (!hasPrecedingCall) {
        out.push({ role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` });
        continue;
      }
    }
    out.push(msg);
  }
  return out;
}


// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  const tiered = models.map((m, i) => ({ m, i, t: tierOf(m) }));
  // If no model matches any hard capability, return original reference (no reorder needed).
  if (tiered.every((x) => x.t === 2)) return models;
  return tiered
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") required.add("pdf");
    // gemini parts: inlineData/fileData carry a mime
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType;
    if (typeof mime === "string" && mime.startsWith("image/")) required.add("vision");
    if (mime === "application/pdf") required.add("pdf");
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanContent(m.content);      // openai / claude
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: detect web_search tool in tools array
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type === "web_search") { required.add("search"); break; }
    }
  }

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Combine multiple AbortSignals into one. The returned signal aborts as soon as
 * any source aborts. Sources that are not AbortSignal instances are ignored.
 */
function combineSignals(...signals) {
  const sources = signals.filter((s) => s && typeof s.addEventListener === "function");
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let aborted = false;

  for (const sig of sources) {
    if (sig.aborted) {
      aborted = true;
      break;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }

  if (aborted) {
    controller.abort();
  }

  return controller.signal;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr, { signal }) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {AbortSignal} [options.signal] - Optional external signal (e.g. client disconnect) that aborts every target
 * @param {number} [options.timeoutMs=DEFAULT_COMBO_TARGET_TIMEOUT_MS] - Max time to wait for a target to return response headers
 * @param {number} [options.queueDepth] - Optional per-combo account-semaphore queue depth (0 = fail immediately on saturation)
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, signal = null, timeoutMs = DEFAULT_COMBO_TARGET_TIMEOUT_MS, queueDepth = null }) {
  // Normalize orphan tool messages (interrupted tool loops leave `tool` role
  // without preceding tool_calls -> upstream 400). Keeps valid tool_calls.
  if (Array.isArray(body.messages)) {
    body = { ...body, messages: flattenOrphanToolMessages(body.messages) };
  } else if (Array.isArray(body.input)) {
    body = { ...body, input: flattenOrphanToolMessages(body.input) };
  }
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];

    // Honor external abort before trying the next target.
    if (signal?.aborted) {
      log.info("COMBO", "External signal aborted — stopping combo fallback");
      return new Response(
        JSON.stringify({ error: { message: "Client disconnected" } }),
        { status: 499, headers: { "Content-Type": "application/json" } }
      );
    }

    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      let result;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        result = await handleSingleModel(body, modelStr);
      } else {
        const timeoutController = new AbortController();
        let timeoutId;
        let timedOut = false;

        const targetSignal = combineSignals(signal, timeoutController.signal);
        const targetOptions = {};
        if (targetSignal) targetOptions.signal = targetSignal;
        if (queueDepth != null) targetOptions.maxQueueSize = queueDepth;

        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            log.warn("COMBO", `Model ${modelStr} exceeded ${timeoutMs}ms timeout — falling back`);
            timeoutController.abort(new Error("combo-per-model-timeout"));
            resolve(
              new Response(
                JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }),
                { status: 524, headers: { "Content-Type": "application/json" } }
              )
            );
          }, timeoutMs);
        });

        try {
          result = await Promise.race([
            Promise.resolve(handleSingleModel(body, modelStr, Object.keys(targetOptions).length > 0 ? targetOptions : undefined)).catch((err) => {
              if (timedOut) {
                // The inner call rejected because we aborted it. The synthetic 524
                // from timeoutPromise already won the race; return an empty response
                // so the loser branch resolves cleanly without leaking err.message.
                return new Response(null, { status: 599 });
              }
              throw err;
            }),
            timeoutPromise,
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    // DeepSeek/GLM-style reasoning-only responses (content null, reasoning filled)
    const r = extractTextContent(msg.reasoning_content);
    if (r.trim()) return r;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Extract tool call requests from a non-streaming model response. Returns
 * [{ name, arguments }] — the thinking model's exploration plan, deferred to
 * the execution pass (the executor holds the client's tools).
 */
function extractToolCalls(json) {
  if (!json || typeof json !== "object") return [];
  const calls = [];

  // OpenAI chat completion: choices[0].message.tool_calls
  const msg = json.choices?.[0]?.message ?? json.choices?.[0]?.delta ?? {};
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc?.function?.name) {
        calls.push({ name: tc.function.name, arguments: tc.function.arguments || "" });
      }
    }
  }

  // Claude messages: content blocks with type "tool_use"
  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (block?.type === "tool_use" && block?.name) {
        calls.push({ name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }
  }

  // Gemini: candidates[0].content.parts with functionCall
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p?.functionCall?.name) {
        calls.push({ name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) });
      }
    }
  }

  // OpenAI Responses API: output items with type "function_call"
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (item?.type === "function_call" && item?.name) {
        calls.push({ name: item.name, arguments: item.arguments || "" });
      }
    }
  }

  return calls;
}

/**
 * Build a thinking artifact from tool calls only (no text). Tells the executor
 * what exploration the thinker wanted, so it can run the same calls with its
 * own tools.
 */
function buildToolPlanPrompt(toolCalls) {
  const plan = toolCalls
    .map((tc, i) => `${i + 1}. ${tc.name}(${tc.arguments})`)
    .join("\n");
  return [
    "The analysis model requested the following tool calls to explore the request.",
    "Run these (or equivalent) with your own tools to gather the needed context,",
    "then answer the user's request.",
    "",
    "=== REQUESTED TOOL CALLS ===",
    plan,
    "=== END REQUESTED TOOL CALLS ===",
  ].join("\n");
}

// Re-parse a REQUESTED TOOL CALLS plan (buildToolPlanPrompt output) back into
// structured calls. Lenient: skips malformed lines rather than failing.
function extractPlannedToolCalls(planText) {
  const calls = [];
  if (typeof planText !== "string") return calls;
  for (const line of planText.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*([A-Za-z_][\w.]*)\((.*)\)\s*$/);
    if (!m) continue;
    calls.push({ name: m[1], arguments: m[2] });
  }
  return calls;
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}

// Think→Execute tuning. Overridable per-combo via settings.comboStrategies[name].
const THINK_EXECUTE_DEFAULTS = {
  thinkingTimeoutMs: 60000, // max time for the thinking model to return headers
  thinkingMaxTokens: 2048,  // cap on thinking output (keeps context lean)
  reviewTimeoutMs: 60000,   // max time for the reviewer model to return
};

/**
 * Handle a think-then-execute combo: a dedicated "thinking" model reasons about
 * the request first (non-streaming, tools stripped), then its analysis is
 * injected as context for the "execution" model, which writes the final answer
 * with the client's original stream flag + tools intact.
 *
 * This mirrors how o-series style reasoning works, but lets the user pick ANY
 * model for each role — e.g. a cheap/fast model to think, a strong one to
 * write, or vice versa. Both default to the combo's first model.
 *
 * Degrades gracefully: thinking failure → execution runs on the original body
 * (no injected context), so the request still succeeds.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Combo models (execution fallback chain)
 * @param {Function} options.handleSingleModel - (body, modelStr, opts) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.thinkingModel] - Model that reasons first; defaults to models[0]
 * @param {string} [options.executionModel] - Model that writes the answer; defaults to models[0]
 * @param {Object} [options.tuning] - Override THINK_EXECUTE_DEFAULTS
 * @returns {Promise<Response>}
 */
export async function handleThinkExecuteChat({ body, models, handleSingleModel, log, comboName, thinkingModel, executionModel, tuning }) {
  const execPool = Array.isArray(executionModel)
    ? executionModel.filter(Boolean)
    : (executionModel && executionModel.trim() ? [executionModel.trim()] : []);
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const cfg = { ...THINK_EXECUTE_DEFAULTS, ...(tuning || {}) };
  const thinker = thinkingModel && thinkingModel.trim() ? thinkingModel.trim() : panel[0];
  if (execPool.length === 0 && panel.length > 0) execPool.push(panel[0]);
  const executor = execPool.length > 0 ? execPool[0] : panel[0];
  log.info("THINK", `Combo "${comboName}" | think=${thinker} | execute=${executor}`);

  // 1. Thinking pass: non-streaming, tool history flattened to prose. Tools are
  //    KEPT (read-only exploration — thinking model can request tool_calls to
  //    inspect files), but tool_choice is removed so it never forces a call.
  //    The thinking model's tool requests are recorded but NOT executed here —
  //    the execution pass has the client's tools intact and runs them.
  const { tool_choice, stream_options, ...rest } = body;
  let thinkBody = { ...rest, stream: false };
  if (cfg.thinkingMaxTokens > 0) thinkBody.max_tokens = cfg.thinkingMaxTokens;
  if (Array.isArray(thinkBody.messages)) {
    thinkBody.messages = flattenToolHistory(thinkBody.messages);
  } else if (Array.isArray(thinkBody.input)) {
    thinkBody.input = flattenToolHistory(thinkBody.input);
  }
  if (cfg.stripThinkContext !== false) {
    const slash = thinker.indexOf("/");
    const tProvider = slash > 0 ? thinker.slice(0, slash) : "";
    const tModel = slash > 0 ? thinker.slice(slash + 1) : thinker;
    const { contextWindow } = getCapabilitiesForModel(tProvider, tModel);
    thinkBody = stripHistoryForContext(thinkBody, contextWindow);
  }

  let thinking = null;
  try {
    const t0 = Date.now();
    const res = await withTimeout(
      handleSingleModel(thinkBody, thinker, true),
      cfg.thinkingTimeoutMs
    );
    if (res && !res.__timeout && !res.__error && res.ok) {
      let json = null;
      try {
        json = await res.clone().json();
      } catch {
        // forceStream providers (autoclaw etc) return SSE even for stream:false
        // — parse the stream and take the final content chunk.
        try {
          const text = await res.clone().text();
          json = parseSseFinal(text);
        } catch {
          json = null;
        }
      }
      if (!json) {
        log.warn("THINK", `thinker ${thinker} response unparseable`);
      }
      const text = extractPanelText(json);
      const toolCalls = extractToolCalls(json);
      if (text && text.trim()) {
        thinking = text.trim();
        log.info("THINK", `thinker ${thinker} produced ${thinking.length} chars in ${Date.now() - t0}ms${toolCalls.length ? `, requested ${toolCalls.length} tool call(s) (deferred to executor)` : ""}`);
      } else if (toolCalls.length) {
        // No text but tool calls — keep them as the thinking artifact so the
        // executor knows what exploration the thinker wanted.
        thinking = buildToolPlanPrompt(toolCalls);
        log.info("THINK", `thinker ${thinker} produced only tool calls (${toolCalls.length}), deferring to executor`);
      } else {
        log.warn("THINK", `thinker ${thinker} returned empty content`);
      }
    } else if (res?.__timeout) {
      log.warn("THINK", `thinker ${thinker} timed out after ${cfg.thinkingTimeoutMs}ms`);
    } else if (res?.__error) {
      log.warn("THINK", `thinker ${thinker} threw`, { error: res.__error?.message || String(res.__error) });
    } else {
      log.warn("THINK", `thinker ${thinker} failed`, { status: res?.status });
    }
  } catch (e) {
    log.warn("THINK", `thinker ${thinker} unexpected error`, { error: e.message || String(e) });
  }

  // 2. Execution pass: original body (stream + tools preserved). If thinking
  //    succeeded, inject it as a user turn so the executor has the analysis.
  //    Same agentic-history guard as the thinker: strip the middle so the
  //    executor's window isn't blown by compaction/browser-snapshot turns.
  let execBody = body;
  // Normalize tool-history shape before handing to the executor: client history
  // can contain orphan `tool` messages (no preceding tool_calls) after an
  // interrupted tool loop — flattening them to prose avoids upstream 400s.
  if (Array.isArray(execBody.messages)) {
    execBody = { ...execBody, messages: flattenOrphanToolMessages(execBody.messages) };
  } else if (Array.isArray(execBody.input)) {
    execBody = { ...execBody, input: flattenOrphanToolMessages(execBody.input) };
  }
  if (cfg.stripExecContext !== false) {
    const slash = executor.indexOf("/");
    const xProvider = slash > 0 ? executor.slice(0, slash) : "";
    const xModel = slash > 0 ? executor.slice(slash + 1) : executor;
    const { contextWindow } = getCapabilitiesForModel(xProvider, xModel);
    execBody = stripHistoryForContext(execBody, contextWindow);
  }
  if (thinking) {
    // Tool-only thinking artifacts are a plan, not an answer — the executor must
    // run them with its own tools, never quote them back. Skip the PRIVATE
    // ANALYSIS framing (it invites literal repetition) and hand the plan to the
    // tool-bearing executor directly so the pipeline actually executes.
    const isToolPlan = /REQUESTED TOOL CALLS/.test(thinking);
    if (isToolPlan) {
      log.info("THINK", "deferring tool plan to executor (raw, no PRIVATE ANALYSIS wrapper)");
      execBody = appendUserTurn(execBody, buildToolPlanPrompt(extractPlannedToolCalls(thinking)));
    } else {
      execBody = appendUserTurn(execBody, buildThinkPrompt(thinking));
    }
  } else {
    log.info("THINK", "no thinking context — executing on original body");
  }
  let execRes = null;
  let execErr = null;
  for (let ei = 0; ei < execPool.length; ei++) {
    const execTry = execPool[ei];
    try {
      execRes = await handleSingleModel(execBody, execTry);
      if (execRes && (execRes.ok || execRes.status < 400)) {
        log.info("THINK", `executor ${execTry} succeeded (pool ${ei + 1}/${execPool.length})`);
        break;
      }
      execErr = execRes?.status ? `status ${execRes.status}` : "empty response";
      log.warn("THINK", `executor ${execTry} failed (${execErr}), trying next in pool`);
    } catch (err) {
      execErr = err.message || String(err);
      log.warn("THINK", `executor ${execTry} threw (${execErr}), trying next in pool`);
    }
  }
  if (!execRes) {
    return new Response(
      JSON.stringify({ error: { message: `All execution models failed: ${execErr}` } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Review pass (optional, opt-in): only runs when reviewEnabled AND a
  //    reviewModel is set (either pinned per-combo or the role adapter). The
  //    reviewer verifies the executor's answer and rewrites it when it finds
  //    gaps. Costs an extra model call — hence opt-in.
  const reviewModelStr = cfg.reviewModel && cfg.reviewModel.trim()
    ? cfg.reviewModel.trim()
    : (cfg.reviewEnabled ? getRoleAdapterModel("execution", {}) : null);
  if (cfg.reviewEnabled && reviewModelStr && execRes) {
    const reviewStart = Date.now();
    try {
      const execText = await readResponseText(execRes);
      if (execText && execText.trim()) {
        const reviewRes = await withTimeout(
          handleSingleModel(
            appendUserTurn(execBody, buildReviewPrompt(execText)),
            reviewModelStr,
            true
          ),
          cfg.reviewTimeoutMs
        );
        if (reviewRes && !reviewRes.__timeout && !reviewRes.__error && reviewRes.ok) {
          const json = await reviewRes.clone().json();
          const verdict = extractVerdict(json);
          if (verdict.finalAnswer) {
            log.info("THINK", `reviewer ${reviewModelStr} rewrote answer (${verdict.finalAnswer.length} chars) in ${Date.now() - reviewStart}ms`);
            return jsonResponse(verdict.finalAnswer);
          }
          log.info("THINK", `reviewer ${reviewModelStr} approved answer in ${Date.now() - reviewStart}ms`);
        } else {
          log.warn("THINK", `reviewer ${reviewModelStr} failed — keeping executor answer${reviewRes?.__timeout ? " (timeout)" : ""}`);
        }
      }
    } catch (e) {
      log.warn("THINK", `reviewer ${reviewModelStr} unexpected error`, { error: e.message || String(e) });
    }
  }

  return execRes;
}

/**
 * Build the context directive for the execution model. The thinking output is
 * framed as private analysis to ground the answer — the executor writes the
 * final response addressed to the user, without mentioning the analysis step.
 */
function buildThinkPrompt(thinking) {
  return [
    "The following is private reasoning about the user's most recent request, produced by a separate analysis pass.",
    "Use it to ground your answer, but do NOT mention it, do NOT refer to it as a separate step, and do NOT quote it verbatim.",
    "Write the final answer directly to the user, as if you had reasoned through it yourself.",
    "",
    "=== PRIVATE ANALYSIS ===",
    thinking,
    "=== END PRIVATE ANALYSIS ===",
  ].join("\n");
}

/**
 * Read a Response's body as text. Uses a clone so the same response can be
 * inspected and still returned to the client afterwards.
 */
async function readResponseText(res) {
  if (!res || !res.ok) return "";
  try {
    const text = await res.clone().text();
    return text || "";
  } catch {
    return "";
  }
}

/**
 * Parse an SSE stream body and return a synthetic chat-completion JSON from
 * the final chunk that carried content. forceStream providers (autoclaw,
 * agentrouter, cline…) return SSE even when asked for stream:false, so the
 * thinking pass can't .json() the response directly.
 */
function parseSseFinal(text) {
  if (!text) return null;
  let finalContent = "";
  let finalReasoning = "";
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content) finalContent += delta.content;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) finalReasoning += delta.reasoning_content;
    } catch {
      // skip malformed chunk
    }
  }
  if (!finalContent && !finalReasoning) return null;
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: finalContent || null,
          reasoning_content: finalReasoning || null,
        },
      },
    ],
  };
}

/**
 * Extract the reviewer's verdict from a non-streaming response. The reviewer
 * either approves (no finalAnswer) or rewrites the answer (finalAnswer).
 * Tolerant of JSON-only or fenced-JSON responses.
 */
function extractVerdict(json) {
  if (!json || typeof json !== "object") return {};
  const text = extractPanelText(json);
  if (!text) return {};

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    const parsed = JSON.parse(candidate.trim());
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.finalAnswer === "string" && parsed.finalAnswer.trim()) {
        return { finalAnswer: parsed.finalAnswer.trim() };
      }
      if (parsed.approved === true) return { approved: true };
      if (parsed.approved === false && typeof parsed.revisedAnswer === "string") {
        return { finalAnswer: parsed.revisedAnswer.trim() };
      }
    }
  } catch {
    // fall through — plain text
  }

  // Plain text or unparseable: treat as approval (don't rewrite on ambiguity).
  return { approved: true };
}

/**
 * Build the reviewer directive. The reviewer sees the executor's answer and
 * either approves or rewrites, replying with strict JSON.
 */
function buildReviewPrompt(execText) {
  return [
    "You are the REVIEWER in a think-execute pipeline. The executor model produced the answer below for the user's request.",
    "Verify it: correctness, completeness against the request, and whether it addresses everything asked.",
    "",
    "If the answer is correct and complete, reply with EXACTLY: {\"approved\": true}",
    "If it has errors or gaps, reply with: {\"finalAnswer\": \"<your corrected, complete answer>\"}",
    "Do NOT add commentary outside the JSON.",
    "",
    "=== EXECUTOR'S ANSWER ===",
    execText,
    "=== END EXECUTOR'S ANSWER ===",
  ].join("\n");
}

/**
 * Build a minimal non-streaming JSON response for the reviewed answer.
 * Mirrors the client's chat completion shape.
 */
function jsonResponse(text) {
  const payload = {
    id: `gen-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "review",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: text, refusal: null },
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
