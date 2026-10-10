// Single source of truth for the kleinnn (`kln`) node model policy.
// Audit 2026-09-29 (self-ID probes, 3 methods) + REVISED same day session 2 with the
// BazaarLink third-party classifier — see Second Brain
// 90 Agent/kleinnn-mask-audit-2026-09-29.md ("REVISI mimo").
//
// KEEP = label matches an independent classifier AND the behavioural probes.
// mimo-v2.5 / v2.6-flash / v2.6-pro were REMOVED from KEEP: classifier says
// anthropic 0.98 (pro), qwen+.98 anthropic (flash), uncertain .54 (2.5), and the
// relay injects a system prompt containing "MiMo" — so their natural self-ID proves
// the injection, not the weights.
// Everything the relay advertises outside KEEP is disabled on this node.
export const KLN = {
  prefix: "kln",
  name: "Kleinnn",
  baseUrl: "https://apill.kleinnn.my.id/v1",
  apiType: "chat",
};

export const KEEP = [
  "glm-5.3-flash",   // Z.ai — BazaarLink predFamily=zhipu, v3f GLM-5.2
  "qwen3.8-27b",     // Alibaba Tongyi Lab — predFamily=qwen
  "qwen3.8-flash",   // Alibaba Tongyi Lab — predFamily=qwen 0.99 (control run)
];

// Everything the relay advertises on /v1/models (14 ids: the 11 in the sales sheet
// plus muse-spark-1.3-contributor, pixel-canary, space-bunny-alpha).
// DISABLE is derived as ALL minus KEEP so the two lists can never drift.
export const ALL_ADVERTISED = [
  "deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-flash-0731",
  "mimo-v2.5", "mimo-v2.6-flash", "mimo-v2.6-pro", "minimax-m2.7",
  "glm-5.3-flash", "hy3", "qwen3.8-27b", "qwen3.8-flash",
  "muse-spark-1.3-contributor", "pixel-canary", "space-bunny-alpha",
];

export const DISABLE = ALL_ADVERTISED.filter((id) => !KEEP.includes(id));
