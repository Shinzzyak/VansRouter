// BeatAPI — OpenAI-compatible gateway whose free tier is addressable only
// through the "-free" model ids: a zero-balance account can call those and
// nothing else. Static list on purpose (the vendor's /v1/text/models catalogue
// is a second source of truth we do not need; a stale id fails loudly).
export default {
  id: "beatapi",
  priority: 120,
  alias: "beatapi",
  aliases: ["beat"],
  uiAlias: "beatapi",
  display: {
    name: "BeatAPI",
    icon: "graphic_eq",
    color: "#1258FF",
    textIcon: "BE",
    website: "https://beatapi.io",
    notice: {
      text: "OpenAI-compatible gateway. Only the -free model ids answer on a zero-balance account; paid ids need a top-up.",
      apiKeyUrl: "https://beatapi.io/dashboard/apikeys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.beatapi.io/v1/chat/completions",
    validateUrl: "https://api.beatapi.io/v1/models",
    retry: { 429: 2 },
  },
  models: [
    { id: "glm-5.3-free", name: "GLM 5.3 (Free)" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash (Free)" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "deepseek-v4-flash-0731-free", name: "DeepSeek V4 Flash 0731 (Free)" },
    { id: "gemini-3.8-flash-free", name: "Gemini 3.8 Flash (Free)" },
  ],
  passthroughModels: true,
};
