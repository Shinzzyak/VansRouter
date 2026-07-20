export default {
  id: "a6api",
  priority: 115,
  alias: "a6api",
  uiAlias: "a6",
  display: {
    name: "A6API",
    icon: "bolt",
    color: "#EF4444",
    textIcon: "A6",
    website: "https://a6api.com",
    notice: {
      apiKeyUrl: "https://a6api.com",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://a6api.com/v1/chat/completions",
    validateUrl: "https://a6api.com/v1/models",
  },
  serviceKinds: ["llm", "embedding"],
  embeddingConfig: {
    baseUrl: "https://a6api.com/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
  models: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  modelsFetcher: { url: "https://a6api.com/v1/models", type: "openai" },
  passthroughModels: true,
};
