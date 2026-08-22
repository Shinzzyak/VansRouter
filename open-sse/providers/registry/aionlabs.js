export default {
  id: "aionlabs",
  priority: 20,
  alias: "aionlabs",
  aliases: ["aion-labs"],
  uiAlias: "aion",
  display: {
    name: "AionLabs",
    icon: "auto_awesome",
    color: "#7C3AED",
    textIcon: "AL",
    website: "https://www.aionlabs.ai",
    notice: {
      text: "⚠️ MASKED MODELS: aion-* models are NOT proprietary — fingerprint tests show they route to third-party models (GLM-4 / Claude 3.5 Sonnet / DeepSeek-R1, inconsistent per request). Treat as anonymous proxy pool, not a real Aion model.",
      apiKeyUrl: "https://www.aionlabs.ai/app/api-keys/",
      signupUrl: "https://www.aionlabs.ai/accounts/signup/",
    },
  },
  category: "apikey",
  authType: "apikey",
  hasOAuth: false,
  authModes: ["apikey"],
  serviceKinds: ["llm"],
  transport: {
    baseUrl: "https://api.aionlabs.ai/v1/chat/completions",
    format: "openai",
    validateUrl: "https://api.aionlabs.ai/v1/models",
    auth: {
      apiKey: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
    retry: {
      429: { attempts: 3, delayMs: 1000 },
      503: { attempts: 2, delayMs: 1000 },
    },
  },
  passthroughModels: true,
  models: [
    { id: "aion-3.0", name: "Aion 3.0", upstreamModelId: "aion-labs/aion-3.0" },
    { id: "aion-3.0-mini", name: "Aion 3.0 Mini", upstreamModelId: "aion-labs/aion-3.0-mini" },
    { id: "aion-2.0", name: "Aion 2.0", upstreamModelId: "aion-labs/aion-2.0" },
    { id: "aion-rp-llama-3.1-8b", name: "Aion RP Llama 3.1 8B", upstreamModelId: "aion-labs/aion-rp-llama-3.1-8b" },
  ],
};
