// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
// prefix -> owning built-in provider id, so a colliding node prefix can be
// reported by name instead of failing silently at request time.
// Last write wins, mirroring open-sse's ALIAS_TO_PROVIDER_ID: when two registry
// entries claim the same prefix, routing resolves to the later entry, so the
// reported owner must be the same one requests actually reach.
const RESERVED_PREFIX_OWNER = new Map(
  Object.keys(LOCAL_PROVIDER_ALIASES).map((k) => [k, LOCAL_PROVIDER_ALIASES[k]])
);
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  RESERVED_PREFIX_OWNER.set(entry.id, entry.id);
  if (entry.alias) {
    RESERVED_PROVIDER_PREFIXES.add(entry.alias);
    RESERVED_PREFIX_OWNER.set(entry.alias, entry.id);
  }
  for (const alias of entry.aliases || []) {
    RESERVED_PROVIDER_PREFIXES.add(alias);
    RESERVED_PREFIX_OWNER.set(alias, entry.id);
  }
}

/**
 * Detect a provider-node prefix that is shadowed by a built-in provider alias.
 *
 * A custom node whose prefix collides with a reserved prefix is unreachable via
 * "<prefix>/<model>": getModelInfo() skips the node lookup for reserved prefixes,
 * so the built-in provider wins and the node silently never receives traffic.
 * Returns the owning built-in provider id, or null when the prefix is free.
 */
export function findReservedPrefixCollision(prefix) {
  const trimmed = String(prefix ?? "").trim();
  if (!trimmed) return null;
  return RESERVED_PREFIX_OWNER.get(trimmed) || RESERVED_PREFIX_OWNER.get(trimmed.toLowerCase()) || null;
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  // If explicitly prefixed with combo/, route it as combo (provider: null)
  if (modelStr.startsWith("combo/")) {
    const comboName = modelStr.slice(6);
    const combo = await getComboByName(comboName);
    if (combo) {
      return { provider: null, model: comboName };
    }
  }

  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  let name = modelStr;
  if (modelStr.startsWith("combo/")) {
    name = modelStr.slice(6);
  } else if (modelStr.includes("/")) {
    // Only check if it's not in provider/model format (unless prefixed with combo/)
    return null;
  }

  const combo = await getComboByName(name);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
