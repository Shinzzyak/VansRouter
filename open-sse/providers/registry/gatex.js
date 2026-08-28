export default {
  id: "gatex",
  priority: 30,
  alias: "gx",
  uiAlias: "gx",
  display: {
    name: "Gate-X (Kiro farm pool)",
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
    // Cloudflare quick tunnel -> Caddy basic-auth :18317 -> gate-x :8317.
    // Re-baked when tunnel rotates; update here OR change to stable hostname
    // once gate-x is exposed via permanent Cloudflare/Tailscale tunnel.
    baseUrl: "https://recipe-including-scheme-barcelona.trycloudflare.com/v1/chat/completions",
    validateUrl: "https://recipe-including-scheme-barcelona.trycloudflare.com/v1/models",
  },
  models: [
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
  ],
};
