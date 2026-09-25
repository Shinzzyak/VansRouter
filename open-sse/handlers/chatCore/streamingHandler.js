import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { normalizeKimiToolCalls } from "../../utils/kimiToolParser.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { createBrandEnforceGate, brandStreamEnforceEnabled } from "../../rtk/streamEnforce.js";
import { wantsJsonOutput } from "../../rtk/brandContract.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { classifyStreamContent } from "../../rtk/streamIntegrity.js";
import { INTEGRITY } from "../../rtk/responseIntegrity.js";
import { recordIntegrity } from "../../rtk/refusalDrift.js";
import { classifyOutcome, firstLevel, recordOutcome } from "../../rtk/selfMeasuringBypass.js";
import { outcomeClassFromIntegrity } from "../../rtk/responseIntegrity.js";
// Re-exported so callers (and the ledger tests) keep importing it from here.
export { outcomeClassFromIntegrity };

/**
 * Map a stream-integrity verdict onto the class vocabulary the self-measuring
 * ledger speaks, so a stream can teach the engine the same way a non-streaming
 * response does.
 *
 * `brandOk` is deliberately NOT used as a win condition: a well-formed answer
 * that lost its brand line is still a good answer, and counting it as one keeps
 * the ledger honest about which framing level actually worked.
 *
 * Returns null for OK — there is nothing to learn from a clean answer that the
 * escalation ladder did not have to fix, and recording a win per request would
 * let volume bury the signal.
 */


const STREAM_EARLY_EOF_STATUS = 502;

/**
 * Peek the first chunk of a ReadableStream to detect early EOF.
 * If the stream closes before any byte arrives, return { empty: true }.
 * Otherwise return the first chunk + the reader so the caller can
 * reconstruct a stream that still contains that first chunk.
 */
async function peekStreamReadiness(body) {
  if (!body || typeof body.getReader !== "function") {
    return { empty: true };
  }
  const reader = body.getReader();
  try {
    const { done, value } = await reader.read();
    if (done) {
      return { empty: true };
    }
    return { empty: false, firstChunk: value, reader };
  } catch (error) {
    reader.cancel?.().catch(() => {});
    throw error;
  }
}

/**
 * Reconstruct a ReadableStream from a peeked first chunk + remaining reader.
 */
function reconstructStream({ firstChunk, reader }) {
  let enqueuedFirst = false;
  return new ReadableStream({
    async pull(controller) {
      if (!enqueuedFirst) {
        controller.enqueue(firstChunk);
        enqueuedFirst = true;
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock?.();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        reader.cancel?.().catch(() => {});
      }
    },
    cancel(reason) {
      reader.cancel?.(reason).catch(() => {});
    }
  });
}

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responseModel }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;
  const isKimiModel = /kimi-k2\./i.test(model || "");

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, isKimiModel ? normalizeKimiToolCalls : null, responseModel);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, isKimiModel ? normalizeKimiToolCalls : null, responseModel);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, isKimiModel ? normalizeKimiToolCalls : null, responseModel);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 * Includes a readiness gate: if upstream closes before any byte arrives,
 * return STREAM_EARLY_EOF so the caller can retry once on the same connection.
 */
export async function handleStreamingResponse({
  providerResponse, provider, model, sourceFormat, targetFormat, userAgent,
  body, stream, translatedBody, finalBody, requestStartTime, connectionId,
  apiKey, apiKeyInfo, apiKeyName, clientModelId, clientRawRequest, onRequestSuccess,
  reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId, pxpipe,
}) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Warn when upstream returns unexpected Content-Type for a streaming response.
  // This often means the provider returned an HTML error page or plain-text error
  // that the SSE transform stream would forward as garbage to the client.
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    console.warn('[STREAM] ' + provider + ' | ' + model + ' | unexpected Content-Type: ' + upstreamContentType);
  }

  // Readiness gate: peek the first chunk before committing to the streaming
  // response. If upstream closes before any byte arrives, signal STREAM_EARLY_EOF
  // so chat.js can retry once on the same connection without marking it down.
  let peek;
  try {
    peek = await peekStreamReadiness(providerResponse.body);
  } catch (error) {
    return {
      success: false,
      status: 502,
      errorCode: "STREAM_EARLY_EOF",
      error: error?.message || String(error)
    };
  }

  if (peek.empty) {
    return {
      success: false,
      status: STREAM_EARLY_EOF_STATUS,
      errorCode: "STREAM_EARLY_EOF",
      error: "Upstream closed stream before any useful content"
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responseModel: clientModelId });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const reconstructedResponse = new Response(reconstructStream(peek), {
    status: providerResponse.status,
    statusText: providerResponse.statusText,
    headers: providerResponse.headers
  });
  // Brand/seal enforcement (opt-in, buffering). Only the chat surface gets it:
  // a JSON-output request would be corrupted by a brand line, and a caller that
  // asked for structured data is not a human reading a reply.
  const brandGate = brandStreamEnforceEnabled() && !wantsJsonOutput(body)
    ? createBrandEnforceGate({
        enabled: true,
        model,
        log: { warn: (...a) => console.warn(`[${a[0]}]`, ...a.slice(1)) },
      })
    : null;
  const transformedBody = pipeWithDisconnect(reconstructedResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, brandGate);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, apiKey, apiKeyName,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, apiKeyInfo, apiKeyName, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    // Why the visible text was empty. A tool-call-only or reasoning-only turn is a
    // NORMAL agent turn that succeeded; a stream that died is not. Both used to be
    // recorded as the same "[Empty streaming response]" with no way to tell them
    // apart. safeContent is intentionally left untouched: the stream-integrity
    // classifier below reads it and must keep seeing exactly what it saw before.
    const finishReason = contentObj?.finishReason ?? null;
    const sawToolCalls = contentObj?.sawToolCalls === true;
    // ONE predicate, three readers (empty_reason, the drift ring, the ledger).
    // Two independent copies of this expression is exactly how the ring and the
    // ledger drifted apart on 2026-09-22: the ledger got the gate, the ring did
    // not, and every tool-call turn was counted as a model-quality failure.
    const toolCallOnly = sawToolCalls || finishReason === "tool_calls";
    const emptyReason = contentObj?.content
      ? null
      : toolCallOnly
        ? "tool_calls"
        : finishReason
          ? `no_text:${finishReason}`
          : "no_text";

    // Stream integrity gate (shadow mode): classify the assembled visible text
    // AFTER the stream completes. Zero hot-path cost — runs once per stream.
    // Reports only; never mutates the bytes already sent to the client.
    try {
      const integrity = classifyStreamContent(safeContent, { requestBody: body });
      // ── Tool-call turns are not model-quality failures (2026-09-25) ──────────
      // The ledger below got this gate on 2026-09-22 and the RING never did, so
      // the ring has been reporting a false signal on the same traffic.
      //
      // A tool-call-only turn produces no visible text BY DESIGN: the model
      // called a tool, which is a successful agent turn. `classifyStreamContent`
      // correctly calls the absent text EMPTY. The ledger skips those (see the
      // sawToolCalls gate below); the ring counted every one of them as a
      // model-quality failure.
      //
      // Measured on the live router: the drift ring printed
      // `codebuddy-intl/deepseek-v4.1-flash ... empty=90%`, which reads as a
      // broken model. Request details for that same model: 566 rows with
      // `empty_reason=tool_calls` and 31 with `None`, against 1,447
      // content-safety 403s that never reach this code at all (a 4xx returns
      // before the streaming handler is built). The model was healthy; the ring
      // was counting tool calls.
      //
      // Skipping loses nothing: `empty_reason` is already persisted per request
      // in `requestDetails.response`, so the distinction stays queryable.
      const ringStatus = toolCallOnly && integrity.status === INTEGRITY.EMPTY
        ? INTEGRITY.OK
        : integrity.status;
      recordIntegrity(provider, model, ringStatus);
      if (integrity.status !== INTEGRITY.OK && !toolCallOnly) {
        console.warn(`[STREAM-INTEGRITY] ${provider}/${model} | ${integrity.status} | chars=${integrity.chars}${integrity.refusal ? " | refusal" : ""}`);
      }
      // Teach the self-measuring ledger from the stream itself. The assembled
      // text is already here and already classified, so this costs one Map
      // write — no extra body read, no extra classification pass. Only the
      // level the request was actually tried at is recorded; a stream that
      // escalated during its head gate did its learning in the escalation
      // branch, not here.
      //
      // GATED ON sawToolCalls (2026-09-22). A tool-call turn produces no visible
      // text BY DESIGN, and classifyStreamContent correctly calls that "empty".
      // Feeding that verdict to the ledger recorded a LOSS for a level that had
      // not failed. Measured: 398 of 399 empty rows were tool_calls, and SENYAP
      // was 2492 of 2686 ledger writes — 93% of the signal was this false loss,
      // which is the exact signal firstLevel() reads back. A tool-call turn has
      // no verdict to teach: it is neither a win nor a loss.
      const kelas = outcomeClassFromIntegrity(integrity.status);
      if (kelas && !(kelas === "SENYAP" && toolCallOnly)) {
        recordOutcome(model, firstLevel(model), kelas, `${provider}/${model}`);
        console.warn(`[STREAM-INTEGRITY] ${provider}/${model} | recorded ${kelas} at ${firstLevel(model)}`);
      }
    } catch (e) {
      console.warn("[STREAM-INTEGRITY] classify error (fail-open):", e?.message || e);
    }

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey, apiKeyName,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: {
        content: safeContent, thinking: safeThinking, type: "streaming",
        finish_reason: finishReason, tool_calls: sawToolCalls, empty_reason: emptyReason
      },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, apiKeyInfo, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
