/**
 * Atria — Shanghai AI Lab (api.atria-asi.ai), OpenAI-compatible.
 *
 * Endpoint   : https://api.atria-asi.ai/v1
 * Auth       : API key, prefix `atr_` (48 char, mengandung `_` dan `-`)
 * Backend    : vLLM (system_fingerprint: vllm-0.26.0-tp8) — model di-host sendiri
 * Region     : Singapore (Alibaba Cloud ALB, ap-southeast-1)
 * Console    : https://api.atria-asi.ai/console (Logto OIDC, Google social login)
 * Kuota      : 100.000.000 token / akun (gratis, via Google signup)
 *
 * PENTING — batasan model (hasil audit langsung, /tmp/atria_audit.json):
 *   - tool calling RUSAK: balikin format XML di `content`, `tool_calls[]` KOSONG,
 *     `finish_reason:"tool_calls"` menyesatkan. Tanpa tool_choice:"required",
 *     parameter `tools` diabaikan total (balas teks biasa, HTTP 200).
 *   - response_format json_object keluarkan JSON tidak valid.
 *   Lihat `tools:false` / `structuredOutput:false` di providers/capabilities.js.
 */

export default {
  id: "atria",
  priority: 60,
  alias: "atria",
  aliases: [
    "atr",
  ],
  uiAlias: "atr",
  display: {
    name: "Atria",
    icon: "blur_on",
    color: "#FF7A00",
    textIcon: "ATR",
    website: "https://atria-asi.ai",
    description: "Shanghai AI Lab — OpenAI-compatible, kuota gratis 100M token/akun (chat only, tool calling tidak didukung)",
  },
  category: "freeTier",
  authType: "apikey",
  authModes: [
    "apikey",
  ],
  serviceKinds: [
    "llm",
  ],
  transport: {
    baseUrl: "https://api.atria-asi.ai/v1/chat/completions",
    validateUrl: "https://api.atria-asi.ai/v1/models",
    format: "openai",
    authType: "apikey",
  },
  models: [
    {
      id: "Atria-Dawn-Preview",
      name: "Atria Dawn Preview",
      kind: "llm",
      // nama model case-sensitive; hanya string ini yang diterima (400 kalau salah)
    },
  ],
};
