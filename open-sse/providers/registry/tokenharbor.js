export default {
  id: "tokenharbor",
  alias: "th",
  uiAlias: "th",
  display: {
    name: "Token Harbor",
    icon: "redeem",
    color: "#2563EB",
    website: "https://tokenharbor.ai",
    notice: "OpenAI-compatible gateway. $5 welcome credit, $2/referral chain.",
  },
  category: "free",
  authModes: ["api_key"],
  hasOAuth: false,
  transport: {
    baseUrl: "https://tokenharbor.ai/v1",
    format: "openai",
    forceStream: false,
    headers: {
      "content-type": "application/json",
    },
    auth: { header: "Authorization", scheme: "bearer" },
  },
  models: [
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      alias: "gpt56luna",
      upstreamModelId: "gpt-5.6-luna",
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      alias: "dsv4f",
      upstreamModelId: "deepseek-v4-flash",
    },
    {
      id: "gpt-4.1",
      name: "GPT-4.1",
      alias: "gpt41",
      upstreamModelId: "gpt-4.1",
    },
    {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      alias: "claude4",
      upstreamModelId: "claude-sonnet-4",
    },
  ],
  features: { usage: true },
};
