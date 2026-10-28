/**
 * Lenient JSON body parser for non-streaming upstream responses.
 *
 * Small gateway proxies behind custom openai-compatible nodes intermittently
 * return bodies that strict JSON.parse rejects: two concatenated objects,
 * trailing HTML/garbage after a complete object, BOM, NDJSON lines.
 * Observed live as "Unexpected non-whitespace character after JSON at
 * position ~800" from zrouter/xgate-class gateways (incident 2026-09-11).
 *
 * Pure function, never throws. Returns the parsed value or null.
 */
function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
}

// Extract the first complete {...} or [...] value at/after `from`,
// respecting string literals and backslash escapes. Returns the substring
// or null when unbalanced / absent.
function extractFirstValue(text, from) {
  const n = text.length;
  let i = from;
  while (i < n && text[i] !== "{" && text[i] !== "[") i++;
  if (i >= n) return null;
  const open = text[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < n; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

// Close every delimiter the writer never got to. Walks the text once, tracking
// string state, then appends the missing quote and the missing closers in reverse
// depth order. Pure string surgery — no parse attempted here.
function closeTruncatedJson(text) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = text;
  if (inStr) out += '"';
  // A dangling `"key":` or trailing comma is not valid JSON once closed.
  out = out.replace(/,\s*$/, "");
  out = out.replace(/,?\s*"[^"\\]*"\s*:\s*$/, "");
  out = out.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

// Decode the escaped tail of a JSON string that was cut mid-flight. Uses
// JSON.parse on the quoted fragment so escapes (\n, \", \uXXXX) resolve exactly
// as the upstream meant them, not approximately.
function decodeStringTail(fragment) {
  try {
    return JSON.parse(`"${fragment}"`);
  } catch {
    try {
      return JSON.parse(`"${fragment.replace(/\\$/,"")}"`);
    } catch {
      return fragment;
    }
  }
}

/**
 * Recover a chat completion whose body was CUT mid-JSON by the upstream.
 *
 * Measured live (2026-10-28, tiprouter.my.id, `tpr/deepseek-v4.1-flash`): the
 * relay answers 200 with a body it stops writing at ~29 KB while the model is
 * still emitting — `finish_reason: length`, JSON truncated inside the `content`
 * string. Strict parse fails, `parseLenientJson` fails (there is no complete
 * value to find), SSE fallback fails (it is not SSE), and the client got a 502
 * for an answer that existed in full on the wire up to the cut.
 *
 * Two attempts, cheapest first:
 *   1. close the open string/containers and parse — keeps usage, finish_reason,
 *      and every field that made it across the cut;
 *   2. last resort: lift the `content` string tail verbatim into a synthetic
 *      completion so the visible text still reaches the client.
 *
 * Returns the completion object, or null when the body carries no recoverable
 * assistant text. Never throws.
 *
 * @param {string} raw — raw upstream body
 * @returns {object|null}
 */
export function salvageTruncatedJson(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text.startsWith("{") || !text.includes('"choices"')) return null;

  const repaired = tryParse(closeTruncatedJson(text));
  if (repaired.ok && repaired.value && typeof repaired.value === "object") {
    const ch = repaired.value.choices?.[0];
    const content = ch?.message?.content;
    if (ch && (typeof content === "string" ? content.trim() : content)) {
      repaired.value._salvaged = "closed";
      return repaired.value;
    }
  }

  const tail = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)$/);
  if (!tail) return null;
  const content = decodeStringTail(tail[1]);
  if (!content || !content.trim()) return null;
  return {
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "length" }],
    _salvaged: "content_tail",
  };
}

export function parseLenientJson(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return null;

  // Fast path: clean body.
  const direct = tryParse(text);
  if (direct.ok) return direct.value;

  // 1) First complete value — handles concatenated objects
  //    ({"a":1}{"b":2}) and trailing garbage/HTML after valid JSON.
  const first = extractFirstValue(text, 0);
  if (first) {
    const p = tryParse(first);
    if (p.ok) return p.value;
  }

  // 2) NDJSON / SSE-ish lines: first parseable object/array line wins.
  if (text.includes("\n")) {
    const lines = text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].trim().replace(/^data:\s*/, "");
      if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
      const p = tryParse(t);
      if (p.ok) return p.value;
      const f = extractFirstValue(t, 0);
      if (f) {
        const p2 = tryParse(f);
        if (p2.ok) return p2.value;
      }
    }
  }

  // 3) Legacy brace-slice: first "{" to last "}" for wrapped bodies.
  const fb = text.indexOf("{");
  const lb = text.lastIndexOf("}");
  if (fb !== -1 && lb > fb) {
    const p = tryParse(text.slice(fb, lb + 1));
    if (p.ok) return p.value;
  }

  return null;
}
