export default {
  id: "robinhood",
  priority: 50,
  hasFree: false,
  alias: "rh",
  uiAlias: "rh",
  display: {
    name: "Robinhood GLM",
    icon: "forest",
    color: "#1B5E20",
    textIcon: "RH",
  },
  category: "custom",
  transport: {
    baseUrl: "https://robinhood.hilalhimawansyah.my.id/v1",
    headers: {
      "Origin": "https://robinhood.hilalhimawansyah.my.id",
      "Referer": "https://robinhood.hilalhimawansyah.my.id/",
    },
  },
  models: [
    {
      id: "glm-5.2",
      name: "GLM-5.2 (Robinhood)",
      contextWindow: 32000,
      maxOutputTokens: 4096,
      capabilities: {
        chat: true,
        vision: false,
        tools: true,
        streaming: true,
        reasoning: true,
      },
    },
  ],
};
