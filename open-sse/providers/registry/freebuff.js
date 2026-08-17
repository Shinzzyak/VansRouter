export default {
  id: "freebuff",
  priority: 130,
  alias: "fb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#A855F7",
    textIcon: "FB",
    website: "https://www.codebuff.com",
    notice: {
      signupUrl: "https://freebuff.com/login",
    },
  },
  category: "apikey",
  hasOAuth: false,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    headers: {
      "user-agent": "ai-sdk/openai-compatible/1.0.0/codebuff",
    },
    auth: {
      header: "Authorization",
      scheme: "Bearer",
    },
    extraBody: {
      // runId wajib — di-set per request oleh connection layer
    },
  },
  models: [
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "mimo/minimax-m2", name: "MiniMax M2" },
  ],
};