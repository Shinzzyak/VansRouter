// OpenCode provider.
//
// The free tier (opencode.ai/zen/v1) gates by TLS/ALPN + client handshake: a
// plain HTTP POST from a datacenter IP gets 403 FreeTierError regardless of
// headers (see second-brain/vansrouter/opencode-403-bridge-opencode-serve-2026-10-14.md).
// The real OpenCode binary passes, so `oc/*` is served through a local
// `opencode serve` bridge instead — see the `oc` connection (node prefix `oc`)
// which is an openai-compatible endpoint on http://127.0.0.1:4870/v1.
//
// This registry entry keeps the historical id/alias for compatibility but NO
// LONGER claims the `oc` / `uiAlias` names and NO LONGER ships a static model
// list — those collide with the `oc` prefix the bridge connection owns.
export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "opencode",
  uiAlias: "opencode",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  // hidden: the upstream /zen/v1 lane is dead from datacenter IPs (403
  // FreeTierError). The working free roster is served by the `oc` bridge
  // connection ("OpenCode Free" node, prefix `oc`) — keep this entry only as
  // the historical id/alias placeholder so nothing else collides.
  hidden: true,
  // noAuth:false so this entry is NOT advertised as a free provider in the
  // model roster — the `oc` bridge connection owns the opencode free roster.
  // The upstream /zen/v1 lane is TLS-gated (403) from datacenter IPs anyway.
  noAuth: false,
  transport: {
    baseUrl: "https://opencode.ai",
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  // ponytail: no static models — the `oc` bridge connection owns that roster.
  // Restore a list here only if the direct upstream lane is ever revived.
  models: [],
  passthroughModels: false,
};
