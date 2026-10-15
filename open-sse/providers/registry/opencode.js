// OpenCode provider (free tier).
//
// The upstream free lane (opencode.ai/zen/v1) gates by TLS/ALPN + client
// handshake: a plain HTTP POST from a datacenter IP gets 403 FreeTierError
// regardless of headers (see second-brain/vansrouter/opencode-403-bridge-opencode-serve-2026-10-14.md).
// The real OpenCode binary passes, so this provider is served through a local
// `opencode serve` bridge — a plain [OI]-compatible endpoint on
// http://127.0.0.1:4870/v1 (pm2: opencode-serve + opencode-bridge).
//
// Two things matter here:
//  1. Do NOT register an executor for "opencode" in executors/index.js.
//     OpenCodeExecutor.buildUrl hardcodes /zen/v1/... and would 403. With no
//     entry in the executors map, getExecutor() falls through to DefaultExecutor,
//     which posts to transport.baseUrl below (the bridge).
//  2. noAuth: true, same shape as mimo-free — the bridge needs no credential and
//     the dashboard renders this as a Free Tier card (category "free").
//
// The roster is auto-detected: modelsFetcher polls the bridge's /v1/models
// (bare ids), so a new upstream model appears with no deploy. The static
// `models` list below is only a seed for when the bridge is unreachable.
export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "http://127.0.0.1:4870/v1/chat/completions",
    noAuth: true,
  },
  models: [
    { id: "big-pickle", name: "Big Pickle" },
    { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash (free)" },
    { id: "space-bunny-free", name: "Space Bunny (free)" },
    { id: "cat-jam-free", name: "Cat Jam (free)" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview (free)" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (free)" },
    { id: "step-5-preview-free", name: "Step 5 Preview (free)" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor (free)" },
  ],
  modelsFetcher: { url: "http://127.0.0.1:4870/v1/models", type: "openai" },
  passthroughModels: true,
};
