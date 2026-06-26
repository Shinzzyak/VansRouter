// AgentRouter — multi-model routing gateway (OpenAI-compatible).
// Passthrough provider: accepts any model ID, no fixed model list.
// Free tier: $200 credits on signup, no credit card required.
export default {
  id: "agentrouter",
  alias: "agentrouter",
  uiAlias: "agentrouter",
  display: {
    name: "AgentRouter",
    icon: "hub",
    color: "#10B981",
    textIcon: "AR",
    website: "https://agentrouter.org",
    notice: {
      // Canonical hint (per registry spec) for future/onboarding UIs.
      apiHint: "Get $200 free credits at https://agentrouter.org/register — no credit card required.",
      // Rendered by the current provider-detail UI (see notice.text / notice.apiKeyUrl).
      text: "Get $200 free credits at https://agentrouter.org/register — no credit card required.",
      apiKeyUrl: "https://agentrouter.org/register",
    },
  },
  category: "freeTier",
  authType: "apikey",
  hasOAuth: false,
  authModes: ["apikey"],
  serviceKinds: ["llm"],
  transport: {
    baseUrl: "https://api.agentrouter.org/v1/chat/completions",
    format: "openai",
    timeoutMs: 30000,
    headers: {},
    auth: {
      apiKey: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
    retry: {
      429: { attempts: 3, delayMs: 500 },
      502: { attempts: 3, delayMs: 500 },
      503: { attempts: 3, delayMs: 1000 },
    },
  },
  models: [],
  passthroughModels: true,
};
