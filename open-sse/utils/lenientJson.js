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
