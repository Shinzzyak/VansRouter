/**
 * Wires the stored semantic-cache setting and the engine epoch into the
 * request-path predicate.
 *
 * Split out of chatHook.js on purpose: the hot path must not import the database
 * layer, so chatHook keeps a plain module-level flag and this module — imported
 * only by the instrumentation hook and /api/cache — is the one that reads
 * settings and writes that flag.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import { getSettings, updateSettings } from "@/lib/localDb";
import { defaultCache } from "./cache.js";
import { setSemanticCacheEnabled } from "./chatHook.js";

/**
 * Settings that change what the engine injects, and therefore what a cached
 * body means. Listed explicitly rather than derived: a new injection setting
 * must be added here by hand, which is the point — a setting that changes the
 * reply and is missing from this list would silently leak across the epoch.
 *
 * `rtkEnabled` / `headroomEnabled` belong here even though they are compressors
 * rather than injectors: they rewrite the request body before it reaches the
 * provider, so they change what the model was asked.
 */
const ENGINE_SETTING_KEYS = [
  "godmodeEnabled",
  "godmodeLevel",
  "bypassMode",
  "cavemanEnabled",
  "cavemanLevel",
  "ponytailEnabled",
  "ponytailLevel",
  "rtkEnabled",
  "headroomEnabled",
];

/** Per-provider overrides of the same settings, under `providerStrategies`. */
const PROVIDER_STRATEGY_INJECTION_KEYS = [
  "godmodeEnabled",
  "godmodeLevel",
  "bypassMode",
  "cavemanEnabled",
  "cavemanLevel",
  "ponytailEnabled",
  "ponytailLevel",
  "rtkEnabled",
  "headroomEnabled",
];

/**
 * The injection settings as one stable string.
 *
 * A provider can override the global injection settings for itself
 * (`providerStrategies[<provider>].godmodeEnabled`, and so on), so the global
 * keys alone are not the whole picture. Only the injection keys are pulled out
 * of each provider entry — a proxy-pool rotation change must not invalidate the
 * cache, because it cannot change the text of a reply.
 */
function injectionFingerprint(settings) {
  const parts = ENGINE_SETTING_KEYS.map((key) => `${key}=${settings?.[key] ?? ""}`);

  const strategies = settings?.providerStrategies;
  if (strategies && typeof strategies === "object") {
    for (const provider of Object.keys(strategies).sort()) {
      const entry = strategies[provider];
      if (!entry || typeof entry !== "object") continue;
      for (const key of PROVIDER_STRATEGY_INJECTION_KEYS) {
        if (entry[key] === undefined) continue;
        parts.push(`${provider}.${key}=${entry[key]}`);
      }
    }
  }

  return parts.join("|");
}

/** The built engine bundle, relative to the server's working directory. */
const ENGINE_BUNDLE = path.join("data", "engine", "engine.cjs");

/**
 * Digest of everything that shapes a reply but does not appear in the request
 * body: the engine bundle itself plus the injection settings.
 *
 * The bundle's size and mtime stand in for its contents — rebuilding the engine
 * changes both, and hashing a multi-megabyte file on every settings write would
 * be waste for a value that only has to change when the file does.
 */
export function engineEpoch(settings) {
  const parts = [injectionFingerprint(settings)];

  try {
    const stat = statSync(path.join(process.cwd(), ENGINE_BUNDLE));
    parts.push(`${ENGINE_BUNDLE}:${stat.size}:${stat.mtimeMs}`);
  } catch {
    // No bundle on this host (dev checkout, standalone without data/): the
    // settings half of the epoch still discriminates. Not fatal.
    parts.push(`${ENGINE_BUNDLE}:absent`);
  }

  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Reads the setting, refreshes the epoch, and applies both to the live cache.
 *
 * @returns {Promise<{ enabled: boolean, salt: string }>}
 */
export async function applySemanticCacheConfig() {
  const settings = await getSettings();
  const salt = engineEpoch(settings);

  defaultCache.setKeySalt(salt);
  setSemanticCacheEnabled(settings?.semanticCacheEnabled === true);

  return { enabled: defaultCache.enabled(), salt };
}

/**
 * Persists the toggle and applies it. Enabling starts from an empty store: the
 * entries that could exist were written under an older epoch, and a fresh start
 * is cheaper to reason about than a partial purge.
 *
 * @param {boolean} on
 */
export async function setSemanticCacheEnabledPersisted(on) {
  await updateSettings({ semanticCacheEnabled: on === true });
  if (on === true) defaultCache.clear();
  return applySemanticCacheConfig();
}
