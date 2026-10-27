// Concern: OpenAI `stop` → upstream stop-sequence fields.
//
// OpenAI accepts a string OR an array. Claude calls it `stop_sequences`, Gemini
// and Vertex call it `generationConfig.stopSequences`, and both reject an empty
// string. Before this module, the request translators silently dropped the
// field: a client sending stop:["\n\n"] still got a runaway reply when the
// request was routed to a non-OpenAI provider.
const MAX_STOP_SEQUENCES = 4; // Claude's ceiling; Gemini allows 5, so 4 is safe for both.

export function normalizeStopSequences(stop) {
  if (stop === undefined || stop === null) return [];
  const list = Array.isArray(stop) ? stop : [stop];
  const out = [];
  for (const s of list) {
    // OpenAI's own docs send "" and [] to mean "no stop"; forwarding "" is a 400
    // on both upstreams, so drop empties instead of passing them on.
    if (typeof s !== "string" || s.length === 0) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length === MAX_STOP_SEQUENCES) break;
  }
  return out;
}
