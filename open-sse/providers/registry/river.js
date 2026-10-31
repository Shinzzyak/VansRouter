// River (api.river.ai) — OpenAI-compatible gateway, exact three-id catalog.
export default {
  id: "river",
  priority: 90,
  alias: "river",
  aliases: ["rvr"],
  uiAlias: "rvr",
  display: {
    name: "River",
    icon: "smart_toy",
    color: "#10B981",
    textIcon: "RV",
    website: "https://www.river.ai",
    notice: {
      text: "Use your River API key (starts with rv_...).",
    },
  },
  category: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.river.ai/v1/chat/completions",
  },
  models: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4", name: "Nemotron 3.5 Super VL 120B" },
    { id: "zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash" },
  ],
};
