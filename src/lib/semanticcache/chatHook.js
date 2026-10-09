/**
 * The two touch points that connect the prompt cache to the chat path.
 *
 * Both are deliberately tiny and fail-open: a cache defect must degrade to a
 * normal upstream call, never to a broken reply. Everything interesting lives in
 * cache.js — this file exists so the hot request path only grows by a call each
 * way instead of importing the whole cache surface.
 */

import { defaultCache, setCacheEnabledPredicate } from "./cache.js";

/**
 * Boot-time switch. Off unless SEMANTIC_CACHE=1, so deploying this file changes
 * no behaviour on a running gateway.
 */
setCacheEnabledPredicate(() => process.env.SEMANTIC_CACHE === "1");

/** Response headers a replayed body carries, so a hit is identifiable on the wire. */
export const CACHE_HIT_HEADER = "X-Router-Cache";

/**
 * Looks for a stored body for this request.
 *
 * @returns {{ response: Response } | null} null on a miss or on any error
 */
export function cacheHitResponse({ requestBody, sessionId = "" }) {
  try {
    const found = defaultCache.lookup(requestBody, { sessionId });
    if (!found.hit) return null;

    return {
      response: new Response(found.body, {
        headers: {
          "Content-Type": found.contentType || "application/json",
          "Access-Control-Allow-Origin": "*",
          [CACHE_HIT_HEADER]: "HIT",
        },
      }),
    };
  } catch {
    // Fail-open: a cache error must never cost the caller a reply.
    return null;
  }
}

/**
 * Stores a completed non-streaming body under this request's key.
 *
 * Called with the FINAL body the client is about to receive, after brand repair,
 * so a replay returns the repaired text rather than the raw upstream one.
 *
 * @returns {boolean} whether the body was stored
 */
export function storeCachedResponse({ requestBody, finalResponse, status = 200, sessionId = "" }) {
  try {
    if (!finalResponse || typeof finalResponse !== "object") return false;
    // Checked before serialising: the caller would otherwise pay a full
    // JSON.stringify of every non-streaming reply just to have the cache discard
    // it. That is real CPU on the hottest path for a feature that is off.
    if (!defaultCache.enabled() || requestBody?.stream === true) return false;
    return defaultCache.put(requestBody, JSON.stringify(finalResponse), {
      contentType: "application/json",
      status,
      sessionId,
    });
  } catch {
    return false;
  }
}

export { defaultCache };
