// WorkBuddy (www.workbuddy.ai) — partner SaaS skin of the CodeBuddy gateway.
// Same OpenAI-compatible SSE gateway shape as codebuddy-intl, different domain
// and OAuth platform ("workbuddy"). Kept as its own provider id so the account
// pools stay separated: a WorkBuddy token and a CodeBuddy token are different
// credentials even though one catalog serves both.
export default {
  id: "workbuddy",
  alias: "wb",
  uiAlias: "wb",
  hidden: false,
  priority: 90,
  display: {
    name: "WorkBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.workbuddy.ai",
    notice: {
      signupUrl: "https://www.workbuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    forceStream: true,
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    usage: {
      url: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  models: [
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5.0", name: "GLM-5.0" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    { id: "hy4-preview", name: "Hy4 Preview" },
    { id: "hy3", name: "Hy3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ],
  oauth: {
    baseUrl: "https://www.workbuddy.ai",
    stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "workbuddy",
    pollInterval: 5000,
  },
};
