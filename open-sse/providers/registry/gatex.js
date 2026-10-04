export default {
  id: "gatex",
  priority: 30,
  alias: "gx",
  uiAlias: "gx",
  display: {
    name: "Gate-X (Kiro Farm Pool)",
    icon: "vpn_key",
    color: "#7C3AED",
    textIcon: "GX",
    website: "https://github.com/SEKAI-MIRROR/gate-x-cli",
    notice: {
      signupUrl: "https://t.me/sekai_gatex_bot",
    },
  },
  category: "api",
  authType: "apikey",
  transport: {
    // The old base was a cloudflared *quick tunnel*
    // (recipe-including-scheme-barcelona.trycloudflare.com). Quick tunnels are
    // ephemeral: the hostname died with the process and every model returned
    // 502 ENOTFOUND. Point straight at the upstream domain instead — it is the
    // same origin the gtx key is issued for and it answers /v1/models.
    baseUrl: "https://api.sekaigateway.xyz/v1/chat/completions",
    validateUrl: "https://api.sekaigateway.xyz/v1/models",
  },
  // Catalog refreshed 2026-10-05 from a live GET /v1/models (14 ids) plus the
  // one free-tier id that answered 200 twice (`bansos/glm-5.3-flash`). Every
  // other id from the previous list returned 404 model_not_found; the ones in
  // the live list that are not free answer 402 premium_required until a token
  // package is bought. Keep this list in sync with /v1/models, not with the
  // gate-x CLI README.
  models: [
    { id: "bansos/glm-5.3-flash", name: "GLM-5.3-Flash (Free tier)" },
    { id: "z-ai/glm-5.3", name: "GLM-5.3" },
    { id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "cc/claude-opus-5", name: "Claude Opus 5" },
    { id: "cx/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "cx/gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "cx/gpt-6-astra", name: "GPT-6 Astra" },
    { id: "speedrun/gpt-6-sol", name: "GPT-6 Sol (Speedrun)" },
    { id: "ds/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "ds/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "ds/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "gemini/gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "xiaomi/mimo-v2.6-flash", name: "MiMo v2.6 Flash" },
    { id: "xiaomi/mimo-v2.6-pro", name: "MiMo v2.6 Pro" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
  ],
};
