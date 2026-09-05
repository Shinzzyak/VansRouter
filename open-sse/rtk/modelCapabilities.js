// Model capability profiles and response failure taxonomy.
// Keep this small and explicit: provider nodes can override family defaults.

const BASE_PROFILE = {
  family: "unknown",
  requestStrategy: "persona",
  personaStrategy: "use",
  inputClassifier: false,
  outputClassifier: false,
  supportsSystemPrompt: "unknown",
  supportsTools: "unknown",
  supportsStreaming: "unknown",
  supportsVision: "unknown",
  reasoningNullContent: true,
};

const FAMILY_PROFILES = {
  muse_spark: {
    family: "muse_spark",
    requestStrategy: "educational_rephrase",
    personaStrategy: "avoid",
    inputClassifier: true,
    outputClassifier: true,
    supportsSystemPrompt: "weak",
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    reasoningNullContent: false,
  },
  deepseek: { family: "deepseek", requestStrategy: "persona", personaStrategy: "use" },
  gemini: { family: "gemini", requestStrategy: "educational", personaStrategy: "use" },
  claude: { family: "claude", requestStrategy: "persona", personaStrategy: "use" },
  grok: { family: "grok", requestStrategy: "persona", personaStrategy: "use" },
  gemma: { family: "gemma", requestStrategy: "educational", personaStrategy: "avoid" },
  mistral: { family: "mistral", requestStrategy: "educational", personaStrategy: "avoid" },
  hunyuan: { family: "hunyuan", requestStrategy: "educational", personaStrategy: "use" },
};

const MODEL_RULES = [
  [/muse[-.]?spark|minimax[-.]?m[23]/i, "muse_spark"],
  [/kimi[-.]?k[23]|mimo[-.]?v?2|glm[-.]?\d|deepseek/i, "deepseek"],
  [/gemini[-.]?\d/i, "gemini"],
  [/claude/i, "claude"],
  [/grok[-.]?\d/i, "grok"],
  [/gemma[-.]?\d/i, "gemma"],
  [/mistral[-.]?(small|7b|8x7b)/i, "mistral"],
  [/hy[34]|hunyuan/i, "hunyuan"],
];

const PROVIDER_FAMILIES = {
  antigravity: "gemini",
  gemini: "gemini",
  vertex: "gemini",
  claude: "claude",
  anthropic: "claude",
  grok: "grok",
  xai: "grok",
};

export function detectCapabilityFamily(provider, model) {
  const name = typeof model === "string" ? model : "";
  for (const [pattern, family] of MODEL_RULES) {
    if (pattern.test(name)) return family;
  }
  return PROVIDER_FAMILIES[String(provider || "").toLowerCase()] || "unknown";
}

export function getModelCapabilityProfile(provider, model) {
  const family = detectCapabilityFamily(provider, model);
  return { ...BASE_PROFILE, ...(FAMILY_PROFILES[family] || {}), family };
}

export function classifyResponseFailure({ status = 200, body = null, message = "" } = {}) {
  const code = Number(status) || 0;
  const text = String(message || body?.error?.message || "");
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "quota";
  if (code >= 500 || code === 0) return "infrastructure";
  if (code >= 400 && code < 500 && /provider rejected this request|content.?safety|content.?policy|classifier|policy restriction/i.test(text)) return "safety_400";
  if (code >= 400) return "client_error";

  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning;
  const tokens = Number(body?.usage?.completion_tokens || 0);
  if (tokens > 0 && !content && reasoning) return "reasoning_only";
  if (tokens > 0 && !content) return "output_filtered";
  if (typeof content === "string" && content.length > 0) return "success";
  return "empty";
}
