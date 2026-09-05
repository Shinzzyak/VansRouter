"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const STORAGE_PREFIX = "vansrouter:model-caps:v1:";
let cache = null;
let inflight = null;

function storageKey(userKey) {
  return `${STORAGE_PREFIX}${encodeURIComponent(userKey || "anonymous")}`;
}

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function readStored(userKey) {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(userKey)) || "null");
    return parsed?.maps?.byFull && parsed?.maps?.byId ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(userKey, maps) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userKey), JSON.stringify({ savedAt: Date.now(), maps }));
  } catch {
    // Storage quota/private mode: memory cache remains usable.
  }
}

function loadModelCaps(userKey) {
  if (cache) return Promise.resolve(cache);
  const stored = readStored(userKey);
  if (stored) {
    cache = stored.maps;
    // Revalidate in background. Fresh server data replaces local snapshot.
  }
  if (inflight) return inflight;
  inflight = fetch("/api/models", { headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      const maps = buildMaps(data.models);
      cache = maps;
      writeStored(userKey, maps);
      return maps;
    })
    .catch(() => cache || { byFull: {}, byId: {} })
    .finally(() => { inflight = null; });
  return inflight;
}

function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return { vision: c.vision, search: c.search, reasoning: c.reasoning, contextWindow: c.contextWindow, maxOutput: c.maxOutput };
}

export function useModelCaps({ userKey = "anonymous" } = {}) {
  const [byFull, setByFull] = useState(() => cache?.byFull || readStored(userKey)?.maps.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || readStored(userKey)?.maps.byId || {});

  useEffect(() => {
    let alive = true;
    loadModelCaps(userKey).then((maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    });
    return () => { alive = false; };
  }, [userKey]);

  const getCaps = useCallback((key) => resolveCaps(byFull, byId, key), [byFull, byId]);
  return { getCaps };
}
