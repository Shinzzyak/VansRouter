export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
    },
  },
  category: "oauth",
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    forceStream: true,
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "clineHeaders",
      ],
    },
  },
  models: [
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash (Fast)" },
    { id: "z-ai/glm-5.3", name: "GLM 5.3" },
    { id: "z-ai/glm-5.2:free", name: "GLM 5.2 (Free)" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "kwaipilot/kat-coder-pro", name: "KAT Coder Pro" },
    { id: "qwen/qwen3.8-flash", name: "Qwen 3.8 Flash" },
    { id: "deeptank/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
    // 2026-10-05 sweep: the two free-tier ids that answered 200 twice on the
    // live account. Every other :free id in the public catalog either 500s
    // ("empty response content" / "failed to invoke model") or 401s on a stale
    // connection. Paid ids are all 402 insufficient_credits on this account —
    // 402 means "model exists, balance is gone" (a bogus id returns 404
    // "model not found"), so the paid list stays as-is until credits return.
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (Free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)" },
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
};
