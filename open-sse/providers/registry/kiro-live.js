import kiroProvider from "./kiro.js";

// Pruned 2026-08-28: ListAvailableModels (live probe, 97-account fleet) only
// exposes 9 models — Auto, Sonnet 4.5/4, Haiku 4.5, DeepSeek 3.2, MiniMax
// M2.5/M2.1, GLM 5, Qwen3 Coder Next. Removed 35 zombies: all opus-4.5/4.7/
// 4.8/5 variants, sonnet-5 variants, gpt-5.6-luna/sol/terra variants.
// Added: claude-sonnet-4, MiniMax-M2.1 (live in API, missing from router).
// Agentic/thinking suffixes for LIVE models kept — executor maps them.

const LIVE = new Set([
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "MiniMax-M2.5",
  "MiniMax-M2.1",
  "glm-5",
  "qwen3-coder-next",
]);

const VARIANTS = ["thinking", "agentic", "thinking-agentic"];

const pruned = {
  ...kiroProvider,
  models: kiroProvider.models.filter((m) => LIVE.has(m.id)),
};

// Add models that were missing entirely
if (!pruned.models.some((m) => m.id === "claude-sonnet-4")) {
  pruned.models.push({ id: "claude-sonnet-4", name: "Claude Sonnet 4" });
}
if (!pruned.models.some((m) => m.id === "MiniMax-M2.1")) {
  pruned.models.push({ id: "MiniMax-M2.1", name: "MiniMax M2.1", strip: ["image", "audio"] });
}

// Generate thinking/agentic variants for live models that support them
// (same convention the registry used before pruning — suffix ids).
const variantModels = [];
for (const m of [...pruned.models]) {
  if (m.id.startsWith("deepseek") || m.id.startsWith("MiniMax") || m.id === "glm-5" || m.id === "qwen3-coder-next") {
    continue; // non-Anthropic models don't take claude-style variants
  }
  for (const v of VARIANTS) {
    variantModels.push({
      ...m,
      id: `${m.id}-${v}`,
      name: `${m.name.replace(/ \(.*\)$/, "")} (${v === "thinking-agentic" ? "Thinking + Agentic" : v[0].toUpperCase() + v.slice(1)})`,
    });
  }
}

export default {
  ...pruned,
  models: [...pruned.models, ...variantModels],
};
