export default {
  id: "gatex",
  // Retired as a dashboard card on 2026-10-05: Gatex now runs as a custom
  // `openai-compatible` node (prefix `skg`) so the API key is editable from the
  // [OI] Compatible section. `hidden: true` drops this entry from
  // APIKEY_PROVIDERS (page.js filters `!info.hidden`) and from
  // getAclProviderList(), while `AI_PROVIDERS` keeps the id so any stored
  // `gatex/*` reference still resolves. Revert = delete this one line.
  hidden: true,
  // Pinned to the top of the connected API Key Providers group: page.js sorts
  // connected-first, then by `priority ?? 999`, then alphabetically, and
  // `APIKEY_INITIAL_VISIBLE = 20` hides the rest behind "Show all". Registry
  // priority is UI ordering only — the priority that routes requests lives on
  // `providerConnections.priority` and this value never reaches it.
  priority: 1,
  // `alias`/`uiAlias` MUST stay "gatex", not "gx": buildProviderEntry() in
  // src/shared/constants/providers.js sets `alias = r.uiAlias || r.alias`, and
  // getProviderAlias() feeds outputAlias in buildConnectedProviderIds(). With
  // category "api" gatex was absent from AI_PROVIDERS, so the lookup fell back
  // to the provider id and the catalog prefix was `gatex/`. Moving it into
  // "apikey" made the lookup succeed and silently renamed every catalog id to
  // `gx/...`, orphaning combos that reference `gatex/*`.
  alias: "gatex",
  uiAlias: "gatex",
  display: {
    name: "Gatex",
    icon: "vpn_key",
    color: "#7C3AED",
    textIcon: "GX",
    website: "https://github.com/SEKAI-MIRROR/gate-x-cli",
    notice: {
      signupUrl: "https://t.me/sekai_gatex_bot",
    },
  },
  // Must stay "apikey": `byCategory()` in src/shared/constants/providers.js only
  // builds sections for free/freeTier/oauth/apikey/webCookie, so category "api"
  // left this provider in NO dashboard section at all. "apikey" + priority 1
  // puts the card at the top of the connected API Key Providers group.
  category: "apikey",
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
