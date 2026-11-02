// Scored auto-routing: one word expresses intent, VansRouter's own health
// and capability data picks the model. A client calls `auto:<intent>` as the
// model; the router expands it into a ranked candidate list and falls back
// through it in order, exactly like a combo (same member cap, same failover).
// No LLM judge is involved — deterministic scoring, no extra inference call.
//
// Candidate pool: registry-seeded models of providers that have at least one
// ACTIVE connection. Providers without seed models contribute nothing
// (inventing model ids would 404 upstream); inject variants are never
// candidates (a variant carries a user prompt — auto-routing must not
// silently inject one). Disabled models (dashboard disabled list) and a
// connection's enabledModels restriction are honoured.
//
// Scoring inputs, all already on hand:
//   * health tier (open-sse connectionHealthTier): clean = 100, suspect = 0.
//     Suspects still serve — they just sort last, so a fully-suspect fleet
//     still routes.
//   * capabilities (getCapabilitiesForModel): tools / reasoning / contextWindow.
//   * exploration: a small share (default 5%) deterministically promotes a
//     lower-ranked candidate to the front (seeded per intent+day, stable across
//     a day instead of flipping per request).
//   * free-ness: FREE_PROVIDERS ids, or a `:free` model-id suffix.
// Ties break alphabetically so the ranking is deterministic per fleet.
//
// Latency: VansRouter has no per-provider measured-latency source wired into
// the routing inputs (requestDetails latency is not aggregated to a p50-query
// path). The documented no-data fallback applies: "fast" scores on the
// small-context proxy, other intents get no latency bonus. Wire a
// `latencyByProvider` map when a measured p50 becomes available.
// ponytail: no latency DB — pass latencyByProvider once a p50 source exists.

import REGISTRY from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { connectionHealthTier, SUSPECT_PROBATION_MS } from "open-sse/services/accountFallback.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

export const AUTO_INTENTS = ["coding", "fast", "cheap", "headroom"];
export const AUTO_CANDIDATE_LIMIT = 8;
export const AUTO_EXPLORATION_SHARE = 0.05;
// At most this many candidates per provider in the final list, so failover
// spans providers instead of collapsing to one provider's catalogue when that
// provider's seeds all outscore everyone else's.
export const AUTO_PER_PROVIDER_LIMIT = 3;

// `auto:coding` (case-insensitive) → "coding"; anything else → null.
export function parseAutoTarget(modelStr) {
  if (typeof modelStr !== "string") return null;
  const m = /^auto:([a-z]+)$/i.exec(modelStr.trim());
  if (!m) return null;
  const intent = m[1].toLowerCase();
  return AUTO_INTENTS.includes(intent) ? intent : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// 0..40 from context size: 4k → 6, 32k → 15, 200k → 23, 1M → 30.
const ctxScore = (ctx) =>
  clamp(Math.round(10 * Math.log10(Math.max(1000, ctx || 1000) / 1000)), 0, 40);

function isFree(providerId, modelId) {
  if (FREE_PROVIDERS && Object.prototype.hasOwnProperty.call(FREE_PROVIDERS, providerId)) return true;
  return typeof modelId === "string" && modelId.endsWith(":free");
}

// enabledModels entries may be bare model ids ("deepseek-ai/..."), full
// "provider/model" strings, or provider-prefixed variants — match on the
// model part (everything after the FIRST slash of the entry).
function enabledMatches(seedId, entries, providerId) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  return entries.some((e) => {
    if (typeof e !== "string") return false;
    if (e === seedId || e === `${providerId}/${seedId}`) return true;
    const slash = e.indexOf("/");
    return slash >= 0 && e.slice(slash + 1) === seedId;
  });
}

function latencyBonus(p50) {
  if (p50 == null || !Number.isFinite(p50) || p50 < 0) return 0;
  return clamp(Math.round(10 - p50 / 500), 0, 10);
}

function fastLatencyScore(p50) {
  if (p50 == null || !Number.isFinite(p50) || p50 < 0) return null;
  return clamp(Math.round(40 - p50 / 100), 0, 40);
}

function scoreCandidate(intent, caps, health, free, latencyMs = null) {
  const ctx = ctxScore(caps?.contextWindow ?? 1000);
  const bonus = latencyBonus(latencyMs);
  switch (intent) {
    case "coding":
      return health + (caps?.tools ? 30 : 0) + (caps?.reasoning ? 20 : 0) + ctx + bonus;
    case "fast": {
      const measured = fastLatencyScore(latencyMs);
      // Measured latency replaces the context proxy when available.
      return health + (measured != null ? measured : 40 - ctx);
    }
    case "cheap":
      return health + (free ? 60 : 0) + Math.round(20 - ctx / 2) + bonus;
    case "headroom":
      return health + ctx * 2 + bonus;
    default:
      return health;
  }
}

// Deterministic exploration: with probability `share`, promote one
// lower-ranked candidate to the front. Pure + testable.
export function applyExploration(ranked, { share = AUTO_EXPLORATION_SHARE, seed = "" } = {}) {
  if (!Array.isArray(ranked) || ranked.length < 2 || !(share > 0)) return ranked;
  let h = 0x811c9dc5;
  for (let i = 0; i < String(seed).length; i++) { h ^= String(seed).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  if ((h % 1000) / 1000 >= share) return ranked;
  const idx = 1 + (h % (ranked.length - 1));
  return [ranked[idx], ...ranked.slice(0, idx), ...ranked.slice(idx + 1)];
}

const providerOf = (candidate) => candidate.slice(0, candidate.indexOf("/"));

/**
 * Rank auto-routing candidates for an intent.
 * @param {object} opts
 * @param {string} opts.intent - one of AUTO_INTENTS
 * @param {object[]} opts.connections - flattened provider connections
 * @param {object} [opts.disabled] - disabled-models map { alias: [modelId] }
 * @param {number} [opts.now] - ms epoch (test seam)
 * @returns {string[]} ranked `provider/modelId` strings, capped.
 */
export function buildAutoCandidates({ intent, connections = [], disabled = {}, now = Date.now(), latencyByProvider = {}, explorationShare = 0, explorationSeed = null }) {
  if (!AUTO_INTENTS.includes(intent)) return [];
  const byProvider = new Map();
  for (const conn of connections) {
    if (!conn?.provider || conn.isActive === false) continue;
    const entry = byProvider.get(conn.provider) || { tier: 1, enabled: null };
    const tier = connectionHealthTier(conn, now, SUSPECT_PROBATION_MS);
    entry.tier = Math.min(entry.tier, tier);
    const enabled = conn.providerSpecificData?.enabledModels;
    if (Array.isArray(enabled)) {
      entry.enabled = entry.enabled ? [...new Set([...entry.enabled, ...enabled])] : [...enabled];
    }
    byProvider.set(conn.provider, entry);
  }

  const scored = [];
  for (const reg of REGISTRY) {
    const prov = byProvider.get(reg.id);
    if (!prov || !Array.isArray(reg.models)) continue;
    const health = prov.tier === 0 ? 100 : 0;
    const disabledIds = new Set([
      ...(disabled[reg.id] || []),
      ...(reg.alias ? disabled[reg.alias] || [] : []),
      ...((reg.aliases || []).flatMap((a) => disabled[a] || [])),
    ]);
    for (const seed of reg.models) {
      if (!seed?.id || disabledIds.has(seed.id)) continue;
      if (!enabledMatches(seed.id, prov.enabled, reg.id)) continue;
      const candidate = `${reg.id}/${seed.id}`;
      if (disabledIds.has(candidate)) continue;
      const caps = getCapabilitiesForModel(reg.id, seed.id);
      const free = isFree(reg.id, seed.id);
      scored.push({ candidate, score: scoreCandidate(intent, caps, health, free, latencyByProvider[reg.id] ?? null) });
    }
  }

  scored.sort((a, b) => b.score - a.score || (a.candidate < b.candidate ? -1 : 1));
  // Interleave per-provider queues (best-first within each provider) so the
  // capped list keeps provider diversity: round 0 = each provider's best,
  // round 1 = each provider's second, and so on.
  const queues = new Map();
  const headScore = new Map();
  for (const s of scored) {
    const provider = s.candidate.slice(0, s.candidate.indexOf("/"));
    const q = queues.get(provider) || [];
    if (q.length === 0) headScore.set(provider, s.score);
    if (q.length < AUTO_PER_PROVIDER_LIMIT) q.push(s.candidate);
    queues.set(provider, q);
  }
  // Queues ordered by their best candidate's score, so round 0 still honours
  // the global ranking while later rounds add provider diversity.
  const ordered = [...queues.values()].sort(
    (a, b) => headScore.get(providerOf(b[0])) - headScore.get(providerOf(a[0])),
  );
  const seen = new Set();
  const out = [];
  let round = 0;
  let progressed = true;
  while (out.length < AUTO_CANDIDATE_LIMIT && progressed) {
    progressed = false;
    for (const q of ordered) {
      if (out.length >= AUTO_CANDIDATE_LIMIT) break;
      const candidate = q[round];
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
        progressed = true;
      }
    }
    round += 1;
  }
  // Exploration last, after diversity interleave, so it only ever swaps
  // the serving order — never the candidate set or the health tiers.
  const seed = explorationSeed ?? `${intent}|${new Date(now).toISOString().slice(0, 10)}`;
  return applyExploration(out, { share: explorationShare, seed });
}

/**
 * Resolve `auto:<intent>` into a ranked candidate list, or null.
 * Live seam: loads active connections + disabled-models map, then ranks.
 * @param {string} modelStr
 * @param {object} [opts]
 * @param {object[]} [opts.connections] - preloaded connections (test seam)
 * @param {object} [opts.disabled] - preloaded disabled map (test seam)
 * @param {number} [opts.now]
 * @returns {Promise<string[]|null>}
 */
export async function getAutoModels(modelStr, opts = {}) {
  const intent = parseAutoTarget(modelStr);
  if (!intent) return null;
  const connections = opts.connections ?? (await getProviderConnections({ isActive: true }));
  const disabled = opts.disabled ?? (await getDisabledModels());
  const candidates = buildAutoCandidates({
    intent,
    connections,
    disabled,
    now: opts.now ?? Date.now(),
    latencyByProvider: opts.latencyByProvider ?? {},
    explorationShare: opts.explorationShare ?? AUTO_EXPLORATION_SHARE,
    explorationSeed: opts.explorationSeed ?? null,
  });
  return candidates.length > 0 ? candidates : null;
}