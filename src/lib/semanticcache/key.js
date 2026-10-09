/**
 * Cache-key construction for the prompt cache.
 *
 * The key is an exact-match digest, not a vector-similarity lookup: two requests
 * share a key only when every input that shapes the completion is byte-identical.
 * The name "semantic" is kept for continuity with the reference implementation,
 * but nothing here compares embeddings — a near-miss prompt is a miss.
 *
 * The discriminating detail is completeness. A key that omits a parameter which
 * changes the answer serves a stale body, and the failure is silent: the caller
 * gets a 200 with the wrong completion. So every shaping input is folded in, and
 * an ABSENT parameter is deliberately not written at all — a request that omits
 * `max_tokens` must not collide with one that pins it to the default.
 */

import { createHash } from "node:crypto";

/** Pulls obj[key][subkey] as a string; "" when either level is absent. */
function nestedString(obj, key, subkey) {
  const inner = obj?.[key];
  if (!inner || typeof inner !== "object") return "";
  const value = inner[subkey];
  return typeof value === "string" ? value : "";
}

/**
 * JSON with object keys sorted, so two structurally identical payloads built in
 * a different key order hash the same. Arrays keep their order: tool order is
 * part of the request.
 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

/**
 * Folds one content block into the digest under a type-tagged label.
 *
 * Text alone is not enough: two multimodal requests that differ only in their
 * image bytes would otherwise share a key and serve each other's responses.
 */
function writeBlock(parts, block) {
  if (typeof block === "string") {
    parts.push(`block:text:${block}`);
    return;
  }
  if (!block || typeof block !== "object") return;

  const type = typeof block.type === "string" ? block.type : "text";
  const text = typeof block.text === "string" ? block.text : "";
  const image = typeof block.image_url?.url === "string" ? block.image_url.url : "";
  const file = typeof block.file?.file_data === "string" ? block.file.file_data : "";
  const audio = typeof block.input_audio?.data === "string" ? block.input_audio.data : "";

  parts.push(`block:${type}:${text}|img=${image}|file=${file}|audio=${audio}`);
}

/** Folds a message's content — string, typed blocks, or bare array — into parts. */
function writeMessage(parts, message) {
  const role = typeof message?.role === "string" ? message.role : "";
  const content = message?.content;

  if (typeof content === "string") {
    parts.push(`${role}:${content}`);
  } else if (Array.isArray(content)) {
    parts.push(`${role}:`);
    for (const block of content) writeBlock(parts, block);
  } else if (content == null) {
    parts.push(`${role}:`);
  } else {
    parts.push(`${role}:${stableJson(content)}`);
  }

  // A tool call carried on the assistant turn is part of the conversation the
  // model sees, so it belongs in the key even though it is not `content`.
  if (message?.tool_calls) parts.push(`${role}:tool_calls:${stableJson(message.tool_calls)}`);
  if (typeof message?.tool_call_id === "string") parts.push(`${role}:tool_call_id:${message.tool_call_id}`);
  if (typeof message?.name === "string") parts.push(`${role}:name:${message.name}`);
}

/** Appends a labeled parameter only when the caller actually supplied it. */
function writeParam(parts, label, value) {
  if (value === undefined || value === null) return;
  parts.push(`${label}:${value}`);
}

/**
 * Builds the cache key for one chat-completion request.
 *
 * Returns "" for an unusable request (missing messages), which callers treat as
 * "do not cache" rather than "cache under the empty key".
 */
export function buildCacheKey(request, { sessionId = "" } = {}) {
  if (!request || !Array.isArray(request.messages) || request.messages.length === 0) return "";

  const parts = [];

  // Tenant / session isolation. Two callers replaying the same prompt with
  // different session identity must not share an entry.
  if (sessionId) parts.push(`session:${sessionId}`);

  parts.push(`model:${typeof request.model === "string" ? request.model : ""}`);

  for (const message of request.messages) writeMessage(parts, message);

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    parts.push(`tools:${stableJson(request.tools)}`);
  }
  writeParam(parts, "tool_choice", request.tool_choice === undefined ? undefined : stableJson(request.tool_choice));

  // Parameters that shape the completion while leaving the prompt byte-identical.
  writeParam(parts, "temperature", request.temperature);
  writeParam(parts, "max_tokens", request.max_tokens);
  writeParam(parts, "max_completion_tokens", request.max_completion_tokens);
  writeParam(parts, "parallel_tool_calls", request.parallel_tool_calls);
  writeParam(parts, "reasoning_effort", request.reasoning_effort);
  writeParam(parts, "top_p", request.top_p);
  writeParam(parts, "seed", request.seed);
  writeParam(parts, "response_format", request.response_format === undefined ? undefined : stableJson(request.response_format));

  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Extracts a normalized text view of the prompt, for search and dashboards. */
export function extractPromptText(request) {
  if (!request || !Array.isArray(request.messages)) return "";
  const lines = [];
  for (const message of request.messages) {
    const role = typeof message?.role === "string" ? message.role : "";
    const content = message?.content;
    if (typeof content === "string") {
      lines.push(`${role}:${content}`);
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      lines.push(`${role}:${text}`);
    } else {
      lines.push(`${role}:`);
    }
  }
  return lines.join("\n");
}
