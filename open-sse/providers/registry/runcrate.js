// Runcrate — OpenAI-compatible inference gateway. /v1/models is public, so a
// valid-looking key passes it; billing/balance is the only endpoint that can
// tell a live key from a dead one, and validateUrl points there.
export default {
  id: "runcrate",
  priority: 65,
  alias: "runcrate",
  aliases: ["rc"],
  uiAlias: "rc",
  display: {
    name: "Runcrate",
    icon: "terminal",
    color: "#1A2B79",
    textIcon: "RC",
    website: "https://www.runcrate.ai",
    notice: {
      apiKeyUrl: "https://www.runcrate.ai/dashboard/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.runcrate.ai/v1/chat/completions",
    validateUrl: "https://www.runcrate.ai/api/v1/billing/balance",
  },
  models: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 1017" },
    { id: "zai-org/GLM-5.3", name: "GLM 5.3" },
    { id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" },
    { id: "Qwen/Qwen3.8-Flash", name: "Qwen3.8 Flash" },
    { id: "openai/gpt-oss-120b", name: "gpt-oss 120B" },
  ],
};
