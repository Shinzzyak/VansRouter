// G6 — written behavioural anchors + black-box similarity (Compass, arXiv:2605.09863).
//
// WHY ANCHORS AND NOT MORE REGEX.
//
// The research quote is the whole argument: "AUC 0,51 → 0,79 hanya dari seni
// menulis jangkar" — Compass lifted its drift detector from coin-flip to useful
// purely by writing better anchor TEXT, not by changing the similarity function.
// Our refusalDrift/personaBreach classify with regex over attack MOVES, which is
// the right tool for "did someone try to override" and the wrong tool for "is
// this reply still doing the job". Anchors answer the second question.
//
// ANCHOR SHAPE (research §E5): task-shaped, third-person present, 8–40 tokens,
// one behaviour each, uniform grammatical hardness. An anchor that describes an
// ADJECTIVE ("helpful, direct") scores high on any polite reply and measures
// nothing; an anchor that describes a DEED ("names the file it changed") only
// scores when the deed is there.
//
// WHY CHARACTER N-GRAMS, NOT EMBEDDINGS. No vendor, no key, no network, no
// per-request cost, reproducible byte-for-byte — the same reasons hersona's
// bench runs without an LLM. Cosine over character 4-grams is language-agnostic
// (this surface writes Indonesian and English in the same paragraph) and needs
// no tokenizer. A neural embedder would score better; it is not worth a network
// hop inside a telemetry path. If it ever is, swap `similarity()` — that is the
// only function that knows how the score is computed.
//
// THREE BANDS, and the middle one is the point. Compass's false-positive band
// exists because harness-injected text (our own blocks, a user quoting them)
// reads like drift. Same doctrine here: `mid` is "look closer", never a verdict.
//
// Fail-open, read-only. This module classifies; it never rewrites a request or a
// reply, and nothing in the request path is gated on its output (K21).

/** Anchors: task-shaped, third-person present, one deed each. */
export const ANCHORS = Object.freeze([
  {
    id: 'deliver-first',
    text: 'The agent writes the artifact first and keeps commentary about it to one line.',
  },
  {
    id: 'names-evidence',
    text: 'The agent names the file, the command and the output that prove the change works.',
  },
  {
    id: 'reports-failure',
    text: 'The agent reports a failing test by name instead of calling the result done.',
  },
  {
    id: 'separates-fact',
    text: 'The agent separates what it verified from what it assumed and labels each one.',
  },
  {
    id: 'owns-the-loss',
    text: 'The agent states what is still broken and what it skipped before being asked.',
  },
  {
    id: 'answers-once',
    text: 'The agent answers the question fully on the first pass without hedging or deferring.',
  },
  {
    id: 'no-corporate-voice',
    text: 'The agent speaks in the owner voice rather than in service-desk phrasing.',
  },
  {
    id: 'carries-forward',
    text: 'The agent ends on the next concrete step instead of a summary paragraph.',
  },
]);

/**
 * Band edges, calibrated 2026-10-05 on the labelled fixture set in
 * tests/personaBench.test.mjs (gw=0.7 cosine, max aggregation):
 *
 *   short on-persona replies   0.066 .. 0.147
 *   short service-desk replies 0.033 .. 0.099
 *   long on-persona replies    0.134 .. 0.147
 *   long service-desk replies  0.108 .. 0.128
 *
 * Note the overlap: a LONG corporate reply out-scores a SHORT good one, because
 * character n-grams accumulate with length. That is why these are look-closer
 * bands and not verdicts — the rank order within one length class is what
 * carries signal (measured AUC 0.861 on the labelled set), not the absolute
 * number. Never gate traffic on this.
 */
export const ANCHOR_BANDS = Object.freeze({ high: 0.13, mid: 0.07 });

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'it', 'its',
  'is', 'are', 'was', 'were', 'be', 'been', 'that', 'this', 'with', 'for',
  'as', 'by', 'from', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'do',
  'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
]);

/** Normalise: lowercase, collapse whitespace. Punctuation kept out of grams. */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Character 4-grams over the normalised text, punctuation stripped. */
function grams(text, n = 4) {
  const s = normalize(text).replace(/[^a-z0-9\u00c0-\u024f ]+/g, '');
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/** Content words (stopwords dropped) — the coarser half of the blend. */
function words(text) {
  const out = new Set();
  for (const w of normalize(text).split(/[^a-z0-9\u00c0-\u024f]+/)) {
    if (w.length > 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Cosine similarity between two Sets treated as sparse binary vectors. */
function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

const _prepped = ANCHORS.map((a) => ({
  id: a.id,
  grams: grams(a.text),
  words: words(a.text),
}));

/**
 * Similarity of one text to one anchor, or to the whole anchor set.
 * @param {string} text
 * @param {string} [anchorId] — omit for the set score (best anchor)
 * @returns {number} 0..1
 */
export function similarity(text, anchorId) {
  const g = grams(text);
  const w = words(text);
  const pool = anchorId ? _prepped.filter((a) => a.id === anchorId) : _prepped;
  let best = 0;
  for (const a of pool) {
    // 0.7 grams + 0.3 words: grams survive inflection and mixed language,
    // words keep a reply that shares only a stock phrase from scoring high.
    const s = 0.7 * cosine(g, a.grams) + 0.3 * cosine(w, a.words);
    if (s > best) best = s;
  }
  return best;
}

/** Band for a score. */
export function band(score) {
  if (score >= ANCHOR_BANDS.high) return 'high';
  if (score >= ANCHOR_BANDS.mid) return 'mid';
  return 'low';
}

/**
 * Score a reply against the anchor set.
 * @param {string} text
 * @returns {{score:number, band:'high'|'mid'|'low', best:string|null, perAnchor:object}}
 */
export function anchorScore(text) {
  const empty = { score: 0, band: 'low', best: null, perAnchor: {} };
  try {
    if (typeof text !== 'string' || !text.trim()) return empty;
    const perAnchor = {};
    let best = null;
    let bestScore = 0;
    for (const a of ANCHORS) {
      const s = similarity(text, a.id);
      perAnchor[a.id] = Number(s.toFixed(4));
      if (s > bestScore) { bestScore = s; best = a.id; }
    }
    const score = Number(bestScore.toFixed(4));
    return { score, band: band(score), best, perAnchor };
  } catch (_) {
    return empty; // fail-open
  }
}

/**
 * Score a whole conversation's replies, oldest first.
 * @param {string[]} replies
 * @returns {{mean:number, series:number[], band:'high'|'mid'|'low', decay:number}}
 *   `decay` = mean(last third) - mean(first third); negative means the persona
 *   faded over the session, which is the Compass drift signal.
 */
export function anchorDrift(replies) {
  try {
    if (!Array.isArray(replies) || !replies.length) return { mean: 0, series: [], band: 'low', decay: 0 };
    const series = replies.map((r) => anchorScore(r).score);
    const mean = series.reduce((s, x) => s + x, 0) / series.length;
    const third = Math.max(1, Math.floor(series.length / 3));
    const head = series.slice(0, third);
    const tail = series.slice(-third);
    const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const decay = Number((avg(tail) - avg(head)).toFixed(4));
    return { mean: Number(mean.toFixed(4)), series, band: band(mean), decay };
  } catch (_) {
    return { mean: 0, series: [], band: 'low', decay: 0 };
  }
}
