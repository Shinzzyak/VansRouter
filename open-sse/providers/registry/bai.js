export default {
  id: "bai",
  priority: 45,
  alias: "bai",
  uiAlias: "bai",
  display: {
    name: "B.AI",
    icon: "bolt",
    color: "#00C2A8",
    textIcon: "BA",
    website: "https://b.ai",
    notice: {
      signupUrl: "https://api.b.ai",
    },
  },
  category: "api",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
  },
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision" },
    { id: "hy3", name: "HY3" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
  ],
  hasFree: false,
  freeNote: "Keys from chat.b.ai/key (Official mode)",
};
