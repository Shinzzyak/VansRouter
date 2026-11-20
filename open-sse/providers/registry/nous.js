// Nous Research provider — direct inference API with Portal OAuth (PKCE).
// OAuth flow mirrors Hermes CLI: authorize at portal.nousresearch.com, PKCE code
// exchange at /api/oauth/token, access token (expires_in 3600) refreshed with the
// refresh token by services/tokenRefresh. Free tier: `:free` models invocable with a
// $0-balance account (scope inference:invoke). Fallback authModes: apikey for Portal keys.
export default {
  id: "nous",
  priority: 10,
  alias: "nous",
  uiAlias: "nous",
  display: {
    name: "Nous Research",
    icon: "smart_toy",
    textIcon: "NS",
    color: "#6366F1",
    website: "https://nousresearch.com",
    notice: {
      text: "Direct Nous inference API. Free models (:free) via Portal OAuth; paid models need Portal credits.",
      apiKeyUrl: "https://portal.nousresearch.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
    validateUrl: "https://inference-api.nousresearch.com/v1/models",
    // Nous reads the nested reasoning:{enabled,effort} dialect only. Probed live on
    // qwen/qwen4-max:free: enable_thinking:false and thinking:{type:"disabled"} are
    // both silently IGNORED (reasoning still emitted, 16 completion tokens), while
    // reasoning:{enabled:false} zeroes it (4 tokens). Without this format the qwen
    // family pattern wins and thinking can never be turned off on Nous.
    thinkingFormat: "nous",
    // Cloudflare di inference-api memblock default node UA (error 1010).
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) HermesCLI/1.0",
    },
    // Hermes CLI first-party client. Token/refresh via /api/oauth/token.
    clientId: "hermes-cli",
    tokenUrl: "https://portal.nousresearch.com/api/oauth/token",
    refreshUrl: "https://portal.nousresearch.com/api/oauth/token",
  },
  oauth: {
    // Device flow (RFC 8628) — SATU-SATUNYA jalur yang diterima server untuk
    // hermes-cli + scope inference:invoke. PKCE authorize endpoint menolak
    // ("agent_not_found" / "unsupported scope").
    clientId: "hermes-cli",
    deviceCodeUrl: "https://portal.nousresearch.com/api/oauth/device/code",
    tokenUrl: "https://portal.nousresearch.com/api/oauth/token",
    refreshUrl: "https://portal.nousresearch.com/api/oauth/token",
    // mint_agent_key lets postExchange trade the 1h access token for a 2h agent key,
    // halving refresh churn. Verified live: POST /api/oauth/agent-key answers
    // 403 insufficient_scope without it, so the scope is required, not decorative.
    agentKeyUrl: "https://portal.nousresearch.com/api/oauth/agent-key",
    scope: "inference:invoke inference:mint_agent_key",
  },
  // Auto-update model list dari upstream (public endpoint, no auth).
  // type "nous-free" (allowedModels.js): filter :free + stealth/* preview.
  modelsFetcher: {
    url: "https://inference-api.nousresearch.com/v1/models",
    type: "nous-free",
  },
  passthroughModels: true,
  // Seed snapshot verified against live /v1/models (413 entries). The previous
  // snapshot was 7/8 dead — laguna-s/xs, hy3, solar-pro4, longcat-2.0 and both
  // hermes-4 weights no longer exist upstream, so routing to them 404'd. Windows
  // and maxOutput below are the provider's own numbers, not family-table guesses.
  models: [
    { id: "tencent/hy4-flash:free", name: "Hunyuan 4 Flash (Free)", contextLength: 1048576, maxOutputTokens: 65536 },
    { id: "meituan/longcat-2.5:free", name: "LongCat 2.5 (Free)", contextLength: 1048576, maxOutputTokens: 131072 },
    { id: "qwen/qwen4-max:free", name: "Qwen4 Max (Free)", contextLength: 1000000, maxOutputTokens: 131072 },
    { id: "upstage/solar-mini4:free", name: "Solar Mini 4 (Free)", contextLength: 524288, maxOutputTokens: 131072 },
    { id: "stepfun/step-3.7-flash:free", name: "Step 3.7 Flash (Free)", contextLength: 262144, maxOutputTokens: 256000 },
  ],
  serviceKinds: ["llm"],
};
