import { CLAUDE_API_HEADERS } from "../shared.js";
// ponytail: CLAUDE_API_HEADERS masih dipakai shared; transport zcode = sidecar lokal (web free tier)

export default {
  id: "zcode",
  priority: 141,
  alias: "zc",
  display: {
    name: "ZCode",
    icon: "smart_toy",
    color: "#0EA5E9",
    textIcon: "ZC",
    website: "https://z.ai",
    notice: {
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "apikey",
  hasOAuth: true,
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
    redirectUri: "zcode://zai-auth/callback",
  },
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
    { id: "GLM-5.1", name: "GLM 5.1", webOnly: true },
    { id: "GLM-5-Turbo", name: "GLM 5 Turbo", webOnly: true },
    { id: "glm-4.7", name: "GLM 4.7", webOnly: true },
    { id: "glm-4-flash", name: "GLM 4 Flash", webOnly: true },
  ],
};
