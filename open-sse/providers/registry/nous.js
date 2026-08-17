// Nous Research provider — routes to OpenRouter-hosted Hermes models.
// Nous has no public API; their open-weight models (Hermes 3/4) are served via
// OpenRouter. This provider reuses the OpenRouter transport (apikey auth) and
// exposes the Hermes model line under the `nous` alias.
// Requires an OpenRouter API key in the connection pool (provider: openrouter).

export default {
  id: "nous",
  priority: 10,
  alias: "nous",
  uiAlias: "nous",
  display: {
    name: "Nous (Hermes)",
    icon: "smart_toy",
    textIcon: "NS",
    color: "#6366F1",
    website: "https://nousresearch.com",
    notice: {
      text: "Nous open-weight models (Hermes 3/4) via OpenRouter. Requires an OpenRouter API key.",
      apiKeyUrl: "https://openrouter.ai/settings/keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  // Mirror openrouter transport — same upstream, Hermes-scoped models.
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    thinkingFormat: "openai",
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  models: [
    { id: "nousresearch/hermes-4-405b", name: "Hermes 4 405B" },
    { id: "nousresearch/hermes-4-70b", name: "Hermes 4 70B" },
    { id: "nousresearch/hermes-3-llama-3.1-405b", name: "Hermes 3 405B" },
    { id: "nousresearch/hermes-3-llama-3.1-70b", name: "Hermes 3 70B" },
  ],
  // Resolve the OpenRouter connection for auth (same key pool).
  useProviderKeyFrom: "openrouter",
  serviceKinds: ["llm"],
  passthroughModels: true,
};
