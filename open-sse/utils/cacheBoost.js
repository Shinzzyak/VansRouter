// Additive prompt-cache boost for Claude-format request bodies.
//
// Anthropic-style prompt caching is prefix-based: the provider caches up to the
// last `cache_control` breakpoint and re-reads it on the next request when the
// prefix matches exactly. Bodies whose static prefix carries no markers get the
// whole system+tools prefix re-processed every turn (the classic ~0% hit-rate
// symptom). This module is purely additive: it never reorders, never deletes,
// and never rewrites a block the engine (godmode / potato / selfMeasuringBypass)
// built, so it cannot change behaviour of a request that already succeeds.
//
// It marks only the two "head" breakpoints — the last system block and the last
// cacheable tool block — which is exactly the keep-set of capCacheControlBlocks()
// in claude.js, so it is safe regardless of call order, and it never exceeds
// Anthropic's 4-breakpoint budget (no 400s).
//
// Gate: settings.enablePromptCacheBoost (default OFF — sold routers stay
// byte-identical unless flipped) or env CACHE_BOOST=1.
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

const MAX_BREAKPOINTS = 4;
const MIN_CACHEABLE_TEXT_LEN = 2048; // less than ~2KB of text rarely pays for a cache write
const REFRESH_MS = 30_000;

let enabled;
let refreshedAt = 0;
let refreshPending = false;

export function countBreakpoints(body) {
  let n = 0;
  for (const block of body?.system || []) if (block?.cache_control) n += 1;
  for (const tool of body?.tools || []) if (tool?.cache_control) n += 1;
  for (const msg of body?.messages || []) {
    for (const block of msg?.content || []) if (block?.cache_control) n += 1;
  }
  return n;
}

export async function refreshCacheBoostEnabled() {
  if (refreshPending) return enabled === true;
  refreshPending = true;
  try {
    const settings = await getSettings();
    enabled = !!settings?.enablePromptCacheBoost || process.env.CACHE_BOOST === "1";
  } catch {
    if (enabled === undefined) enabled = false; // keep last known value; default off
  } finally {
    refreshedAt = Date.now();
    refreshPending = false;
  }
  return enabled === true;
}

// Sync read for callers in non-async hot paths. Kicks a background refresh; the
// caller never blocks on it, so a slow/broken settings store cannot stall a send.
export function isCacheBoostEnabled() {
  if (enabled === undefined || Date.now() - refreshedAt > REFRESH_MS) {
    refreshCacheBoostEnabled(); // fire-and-forget
  }
  return enabled === true;
}

// Mark the system head and the last cacheable tool head with ephemeral
// cache_control. No-op when the client already spends the budget.
export function applyCacheBoost(body) {
  if (!body || typeof body !== "object") return body;
  if (countBreakpoints(body) >= MAX_BREAKPOINTS) return body;

  const system = Array.isArray(body.system) ? body.system : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  let budget = MAX_BREAKPOINTS - countBreakpoints(body);

  const sysHead = system[system.length - 1];
  if (
    budget > 0 &&
    sysHead &&
    !sysHead.cache_control &&
    sysHead.type === "text" &&
    typeof sysHead.text === "string" &&
    sysHead.text.length >= MIN_CACHEABLE_TEXT_LEN
  ) {
    sysHead.cache_control = { type: "ephemeral" };
    budget -= 1;
  }

  for (let i = tools.length - 1; i >= 0 && budget > 0; i -= 1) {
    const tool = tools[i];
    if (tool?.cache_control || tool?.defer_loading === true) continue;
    tool.cache_control = { type: "ephemeral" };
    budget -= 1;
  }

  return body;
}
