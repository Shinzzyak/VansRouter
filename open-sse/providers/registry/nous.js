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
    scope: "inference:invoke",
  },
  // Auto-update model list dari upstream (public endpoint, no auth).
  // type "nous-free" (allowedModels.js): filter :free + stealth/* preview.
  modelsFetcher: {
    url: "https://inference-api.nousresearch.com/v1/models",
    type: "nous-free",
  },
  passthroughModels: true,
  models: [
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (Free)" },
    { id: "tencent/hy3:free", name: "Hunyuan 3 (Free)" },
    { id: "stepfun/step-3.7-flash:free", name: "Step 3.7 Flash (Free)" },
    { id: "upstage/solar-pro4:free", name: "Solar Pro 4 (Free)" },
    { id: "meituan/longcat-2.0:free", name: "LongCat 2.0 (Free)" },
    // Open-weight Hermes line (paid credits)
    { id: "NousResearch/hermes-4-405b", name: "Hermes 4 405B" },
    { id: "NousResearch/hermes-4-70b", name: "Hermes 4 70B" },
  ],
  serviceKinds: ["llm"],
};
