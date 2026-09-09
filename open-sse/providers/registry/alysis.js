export default {
  id: "alysis",
  alias: "alysis",
  uiAlias: "alysis",
  display: {
    name: "Alysis Code",
    icon: "code",
    color: "#F97316",
    website: "https://alysiscode.com",
    notice: "Alysis Code Pro Gateway (RFC 8628 Device Flow / slk_ API Key)",
  },
  category: "freeTier",
  authModes: ["api_key"],
  hasOAuth: false,
  modelsFetcher: {
    url: "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/llm/v1/models",
  },
  transport: {
    baseUrl: "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/llm/v1",
    format: "openai",
    forceStream: false,
    headers: {
      "content-type": "application/json",
    },
    auth: { header: "Authorization", scheme: "bearer" },
  },
  models: [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      alias: "dsv4f",
      upstreamModelId: "DeepSeek-v4-flash",
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision Exp",
      alias: "dsv4f-vision",
      upstreamModelId: "DeepSeek-v4-flash-vision-exp",
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      alias: "dsv4p",
      upstreamModelId: "DeepSeek-v4-pro",
    },
    {
      id: "deepseek-v4.1-flash-expires-on-0910",
      name: "DeepSeek V4.1 Flash (0910)",
      alias: "dsv41f",
      upstreamModelId: "DeepSeek-v4.1-flash-expires-on-0910",
    },
  ],
};
