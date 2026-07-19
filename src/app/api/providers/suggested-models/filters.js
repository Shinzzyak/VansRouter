// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// NVIDIA NIM does not return pricing/is_free fields. Source of truth = local
// registry. The registry is the same source OpenCode uses implicitly via the
// "-free" suffix convention — registry lists only models VansRouter exposes,
// so it's by definition the free/allowed set.
import nvidiaRegistry from "../../../../../open-sse/providers/registry/nvidia.js";
const NVIDIA_FREE_MODEL_IDS = new Set(
  (nvidiaRegistry?.models ?? [])
    .filter((m) => m.kind !== "embedding") // only LLM, not embedding
    .map((m) => m.id)
);

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .reduce((acc, m) => {
        if (m.pricing?.prompt === "0" && m.pricing?.completion === "0" && m.context_length >= 200000) {
          acc.push({ id: m.id, name: m.name, contextLength: m.context_length });
        }
        return acc;
      }, [])
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models.reduce((acc, m) => {
      if (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) {
        acc.push({ id: m.id, name: m.id });
      }
      return acc;
    }, []),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : []).reduce((acc, m) => {
      if (m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo")) {
        acc.push({ id: m.id, name: m.name || m.id });
      }
      return acc;
    }, []),

  // NVIDIA NIM: filter only free-tier models by ID whitelist.
  // The NVIDIA /v1/models endpoint does not expose pricing/is_free fields,
  // so we cannot filter server-side. Whitelist is the source of truth.
  "nvidia": (models) =>
    (Array.isArray(models) ? models : []).reduce((acc, m) => {
      if (m.id && NVIDIA_FREE_MODEL_IDS.has(m.id)) {
        acc.push({ id: m.id, name: m.id });
      }
      return acc;
    }, []),
};
