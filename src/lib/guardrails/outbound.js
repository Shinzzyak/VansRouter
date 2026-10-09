// Outbound tap: applies a guardrail engine to the model's reply on its way to
// the client.
//
// A buffered rewrite is impossible once bytes are on the wire, and for an event
// stream it does not even help on the buffer: the text a policy matches spans
// the decoded string values of several frames, so concatenating the raw frames
// never yields a matchable value. Each event is therefore decoded, its
// model-visible text appended to a sliding window, and only frames whose text
// has settled are re-encoded and released. The rest stay held — which is what
// makes a value split across two deltas ("billing@acme-" + "corp.com")
// catchable.
//
// Ported from 9router-go internal/guardrails/outbound.go + sse_frame.go.

import { ACTION, BLOCKED_RESPONSE_MESSAGE, blocked, strictestAction } from "./engine.js";

/**
 * How much model text an outbound scan keeps back before deciding on it.
 *
 * A value is routinely split across two deltas, so judging each frame alone
 * would miss every address that landed on a boundary. The window is the largest
 * plausible single value: anything longer is not one entity, and keeping more
 * would mean re-scanning an ever-growing buffer on every chunk.
 */
export const SCAN_WINDOW_CHARS = 512;

export const STREAM_FORMAT = { openai: "openai", claude: "claude", responses: "responses" };

// A stream cut by a policy must end the way any other completed stream does, or
// strict clients wait for a terminal frame that never comes.
const TERMINAL_FRAMES = {
  [STREAM_FORMAT.claude]: 'data: {"type":"message_stop"}\n\n',
  [STREAM_FORMAT.responses]:
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"guardrail","status":"failed","error":{"code":"guardrail_blocked","message":"' +
    BLOCKED_RESPONSE_MESSAGE +
    '"}}}\n\n',
  [STREAM_FORMAT.openai]: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
};

/** Splits the first complete SSE event off an accumulated buffer. */
export function nextSseEvent(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const idx = normalized.indexOf("\n\n");
  if (idx < 0) return { event: null, rest: buffer };
  return { event: normalized.slice(0, idx + 2), rest: normalized.slice(idx + 2) };
}

/** An event's data fields and whether it carried any. */
export function sseDataFields(event) {
  const fields = [];
  for (const line of event.replace(/\n+$/, "").split("\n")) {
    if (line.startsWith(":")) continue; // comment / keep-alive
    const cut = line.indexOf(":");
    if (cut < 0 || line.slice(0, cut) !== "data") continue;
    // Per the SSE spec, strip a single optional leading space.
    fields.push(line.slice(cut + 1).replace(/^ /, ""));
  }
  return { fields, ok: fields.length > 0 };
}

/** The joined data fields of an event, which is what a scanner judges. */
export function ssePayload(event) {
  const { fields, ok } = sseDataFields(event);
  if (!ok) return { payload: null, ok: false };
  return { payload: fields.join("\n"), ok: true };
}

/** Separates an event's non-data lines from its data fields, so the envelope can be rebuilt. */
export function splitEvent(event) {
  let prefix = "";
  const fields = [];
  for (const line of event.replace(/\n+$/, "").split("\n")) {
    if (line.startsWith(":")) {
      prefix += `${line}\n`;
      continue;
    }
    const cut = line.indexOf(":");
    if (cut >= 0 && line.slice(0, cut) === "data") {
      fields.push(line.slice(cut + 1).replace(/^ /, ""));
      continue;
    }
    prefix += `${line}\n`;
  }
  return { prefix, fields };
}

/** Writes a masked payload back into an event's envelope. */
export function rebuildEvent(prefix, payload) {
  return `${prefix}data: ${payload}\n\n`;
}

/**
 * The strings a policy judges: the delta content on an [OI] or Responses chunk,
 * or the text delta on an Anthropic one.
 *
 * Only those are judged. A whole-payload scan would also read the fields the
 * provider put there — ids, model names, finish reasons — and a detector that
 * fired on those would redact metadata the client needs to make sense of the
 * frame.
 */
export function payloadText(payload) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const delta = choice && typeof choice === "object" ? choice.delta : null;
    if (delta && typeof delta === "object" && typeof delta.content === "string") out.push(delta.content);
  }
  const block = payload.content_block;
  if (block && typeof block === "object" && typeof block.text === "string") out.push(block.text);
  if (typeof payload.delta === "string") out.push(payload.delta);
  return out;
}

/** Writes replacement strings back into a decoded payload, in payloadText order. */
export function setPayloadText(payload, values) {
  let i = 0;
  const next = () => values[i++];
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const delta = choice && typeof choice === "object" ? choice.delta : null;
    if (delta && typeof delta === "object" && typeof delta.content === "string") delta.content = next();
  }
  const block = payload.content_block;
  if (block && typeof block === "object" && typeof block.text === "string") block.text = next();
  if (typeof payload.delta === "string") payload.delta = next();
}

/**
 * Distributes a masked window back across the frames that produced it.
 *
 * Each frame contributed a known span of the original text, and only the frames
 * the redaction touched may change. The replaced regions come from the engine
 * rather than from diffing the masked text against the original: a diff has to
 * guess where the change starts and ends, and one character of slack is enough
 * to drop the space next to a redacted address. With the exact regions the
 * rewrite is a splice, and concatenating the parts reproduces the masked text
 * character for character.
 *
 * The replacement goes whole into the frame the change begins in. Splitting the
 * masked text back by the original span lengths would chop it in half across two
 * frames ("[REDACT" then "ED]"), which is the artefact the redaction prevents.
 *
 * @param {string} original the window's joined text
 * @param {number[]} spans each frame's contribution to `original`, in order
 * @param {{start: number, end: number, redacted: string}[]} regions replaced spans, sorted, non-overlapping
 */
export function remapFrames(original, spans, regions) {
  const out = new Array(spans.length).fill("");
  let pos = 0;
  let ri = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const frameStart = pos;
    const frameEnd = pos + Math.max(spans[i], 0);
    pos = frameEnd;
    let cur = frameStart;
    let part = "";
    while (cur < frameEnd) {
      const region = regions[ri];
      // No region left, or the next one begins after this frame: the rest of the
      // frame is untouched text.
      if (!region || region.start >= frameEnd) {
        part += original.slice(cur, frameEnd);
        break;
      }
      if (region.start > cur) {
        const upto = Math.min(region.start, frameEnd);
        part += original.slice(cur, upto);
        cur = upto;
      }
      if (cur === region.start && region.start < frameEnd) part += region.redacted;
      cur = Math.min(region.end, frameEnd);
      if (cur >= region.end) ri += 1;
    }
    out[i] = part;
  }
  return out;
}

/**
 * Streaming filter. Feed it decoded SSE text; it returns the text that may go
 * out now and latches once a policy cuts the stream.
 *
 * Frames with no judged text — a comment, a "[DONE]" sentinel, a usage-only
 * chunk — are queued too. They are never masked, but they still have to reach
 * the client in arrival order, so they wait their turn rather than being written
 * straight through: writing one early would put it ahead of every model frame
 * still sitting in the window.
 */
export class OutboundFilter {
  constructor(engine, format = STREAM_FORMAT.openai) {
    this.engine = engine;
    this.format = format in TERMINAL_FRAMES ? format : STREAM_FORMAT.openai;
    this.held = [];
    this.buffer = "";
    this.isBlocked = false;
    this.terminated = false;
    // The strictest decision this stream produced, or null when it stayed clean.
    // Collected rather than reported per window: a log_only rule would otherwise
    // write one audit row per held window for the same match.
    this.firing = null;
  }

  /** Keeps the strictest decision seen, so the audit fires once per stream. */
  #note(decision) {
    if (!decision || decision.action === ACTION.allow) return;
    // Replace only when the new decision is at least as strict, so the recorded
    // findings name the match that actually decided the outcome.
    if (this.firing && strictestAction(decision.action, this.firing.action) !== decision.action) return;
    this.firing = { action: decision.action, findings: decision.findings || [] };
  }

  /** Feeds one chunk of decoded text; returns the text to write. */
  write(chunk) {
    if (this.isBlocked) return "";
    this.buffer += chunk;
    let out = "";
    for (;;) {
      const { event, rest } = nextSseEvent(this.buffer);
      if (event === null) break;
      this.buffer = rest;
      out += this.#handleEvent(event);
      if (this.isBlocked) break;
    }
    return out;
  }

  /** Releases the held window and terminates a blocked stream. */
  close() {
    if (this.isBlocked) return this.#terminal();
    let out = "";
    const pending = this.buffer;
    if (pending.trim()) {
      this.buffer = "";
      const { event } = nextSseEvent(`${pending}\n\n`);
      if (event) out += this.#handleEvent(event);
    }
    if (this.isBlocked) return out + this.#terminal();
    out += this.#release(true);
    return out;
  }

  #handleEvent(event) {
    const { prefix } = splitEvent(event);
    const frame = { prefix, raw: event, text: "", payload: null };

    const { payload, ok } = ssePayload(event);
    if (ok && payload !== null) {
      let decoded = null;
      try {
        decoded = JSON.parse(payload);
      } catch {
        decoded = null;
      }
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        frame.payload = decoded;
        // The join is deliberately empty: it makes every string's offset in the
        // joined text the same in the original and in the masked text, which is
        // what lets a replacement be written back into the exact event that
        // carried it.
        frame.text = payloadText(decoded).join("");
      }
    }

    // The block is judged over the whole window, not just the new frame: the
    // value that matched may have started several frames ago.
    const decision = this.engine.scan(this.#windowText() + frame.text);
    this.#note(decision);
    if (blocked(decision)) return this.#block();

    this.held.push(frame);
    return this.#release(false);
  }

  #windowText() {
    let out = "";
    for (const frame of this.held) out += frame.text;
    return out;
  }

  /**
   * Writes the frames whose text can no longer change and keeps the rest held.
   * `final` is set at stream end, when nothing can arrive to extend the window.
   */
  #release(final) {
    if (!this.held.length) return "";
    let keep = 0;
    if (!final) {
      keep = this.#tailFrames();
      if (keep === this.held.length) return "";
    }
    const out = this.#writeFrames(this.held.slice(0, this.held.length - keep));
    this.held = this.held.slice(this.held.length - keep);
    return out;
  }

  /** How many trailing frames cover the last SCAN_WINDOW_CHARS of text. */
  #tailFrames() {
    let keep = 0;
    let budget = 0;
    for (let i = this.held.length - 1; i >= 0; i -= 1) {
      budget += this.held[i].text.length;
      keep += 1;
      if (budget >= SCAN_WINDOW_CHARS) break;
    }
    return keep;
  }

  /**
   * Masks and writes a window, treating its frames as one piece of text so a
   * value spanning them is redacted once.
   *
   * When nothing matched, every frame is relayed from its original bytes:
   * re-encoding an untouched payload reorders its keys, so every clean frame of
   * a filtered stream would come back reshuffled — still valid JSON, but no
   * longer byte-identical to what the provider sent, and not something a filter
   * should cause.
   */
  #writeFrames(window) {
    if (!window.length) return "";
    const original = window.map((f) => f.text).join("");
    const decision = this.engine.scan(original);
    this.#note(decision);
    if (decision.mutated === undefined) return window.map((f) => f.raw).join("");

    const spans = window.map((f) => f.text.length);
    const parts = remapFrames(original, spans, decision.regions || []);
    let out = "";
    window.forEach((frame, i) => {
      if (parts[i] === frame.text) {
        out += frame.raw;
        return;
      }
      // Only the frame carrying the replacement is re-encoded.
      const payload = { ...frame.payload };
      setPayloadText(payload, [parts[i]]);
      out += rebuildEvent(frame.prefix, JSON.stringify(payload));
    });
    return out;
  }

  #block() {
    this.isBlocked = true;
    this.held = [];
    this.buffer = "";
    return this.#terminal();
  }

  #terminal() {
    if (this.terminated) return "";
    this.terminated = true;
    return TERMINAL_FRAMES[this.format];
  }
}

/**
 * Applies an engine to a non-streamed response body. The buffered half of the
 * outbound tap: nothing is written yet, so the body can be rewritten in full.
 *
 * @returns {{body: string, action: string}}
 */
export function filterResponseBody(engine, body) {
  if (!engine?.enabled() || !body) return { body, action: ACTION.allow, findings: [] };
  let decoded = null;
  try {
    decoded = JSON.parse(body);
  } catch {
    // Not JSON — scan it as plain text so a bare-text body is still covered.
    const decision = engine.scan(body);
    if (blocked(decision)) return { body: "", action: ACTION.block, findings: decision.findings || [] };
    if (decision.mutated === undefined) return { body, action: decision.action, findings: decision.findings || [] };
    return { body: decision.mutated, action: decision.action, findings: decision.findings || [] };
  }
  const { payload, action, mutated, findings } = engine.scanJson(decoded);
  // A block discards the body: the caller answers with the policy message
  // instead, so nothing the policy matched reaches the client.
  if (action === ACTION.block) return { body: "", action, findings: findings || [] };
  // Nothing was replaced, so the caller's original bytes are forwarded rather
  // than a re-serialised copy of the same object.
  if (!mutated) return { body, action, findings: findings || [] };
  return { body: JSON.stringify(payload), action, findings: findings || [] };
}

/**
 * Wraps a streamed response body with the outbound tap. Returns the original
 * stream untouched when the engine is inert, so a disabled policy costs nothing.
 *
 * A TransformStream rather than a hand-rolled ReadableStream: the filter
 * deliberately emits nothing while a frame is still inside the scan window, and
 * a `pull`-driven source that resolves without enqueuing is never asked to pull
 * again — the stream stalls on the first partial frame. `transform` is driven by
 * the write side, so holding data back is free, and `pipeThrough` keeps
 * backpressure intact.
 */
export function pipeGuardrailStream(readable, engine, format = STREAM_FORMAT.openai, onFiring = null) {
  if (!engine?.enabled() || !readable) return readable;
  const filter = new OutboundFilter(engine, format);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const out = filter.write(decoder.decode(chunk, { stream: true }));
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const out = filter.write(decoder.decode()) + filter.close();
        if (out) controller.enqueue(encoder.encode(out));
        // Reported at stream end, once, from the filter's own record: a stream is
        // a single audit event even when several frames tripped the same rule.
        if (onFiring && filter.firing) onFiring(filter.firing);
      },
    })
  );
}
