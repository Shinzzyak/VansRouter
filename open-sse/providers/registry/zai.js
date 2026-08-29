// ponytail: dedicated sidecar provider — transport langsung ke zai_sidecar :8879
// (UI-driven chat.z.ai free tier; tool_calls DIDUKUNG — multi-turn proven).
// zcode (ZCode Plan API) tetap di executor terpisah butuh JWT fresh.
import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "zai",
  priority: 142,
  alias: "za",
  display: {
    name: "ZAI Sidecar",
    icon: "smart_toy",
    color: "#10B981",
    textIcon: "ZA",
    website: "https://chat.z.ai",
    notice: {
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "apikey",
  hasOAuth: false,
  transport: {
    baseUrl: "http://127.0.0.1:8879/v1/chat/completions",
    format: "openai",
    headers: { "Content-Type": "application/json" },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "glm-5.2", name: "GLM 5.2", webOnly: true },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", webOnly: true },
    { id: "glm-4.5v", name: "GLM 4.5V", webOnly: true },
    { id: "glm-4-flash", name: "GLM 4 Flash", webOnly: true },
    { id: "glm-4-air-250414", name: "GLM 4 Air", webOnly: true },
    { id: "GLM-4.1V-Thinking-FlashX", name: "GLM 4.1V Thinking FlashX", webOnly: true },
    { id: "glm-4.6v", name: "GLM 4.6V", webOnly: true },
  ],
};
