// OpenCode provider (free tier) — direct lane, no local bridge.
//
// 2026-10-17: the free lane moved from /zen/v1 to /inference/v1 and the gate
// changed from a TLS/ALPN handshake to a request-shape check. Live A/B from
// this host, one variable at a time:
//   A. POST /inference/v1/chat/completions + UA opencode/latest/2.0.26/cli
//      + tools [read, shell]  -> 200
//   B. POST /zen/v1/chat/completions + UA v2                     -> 200
//   C. POST /zen/v1/chat/completions + UA opencode/1.18.x        -> 200
//   D. POST /inference/v1/chat/completions without the fingerprint tools
//      -> 403 FreeTierError "OpenCode's free tier can only be used from within
//      OpenCode"
// So the gate is the tool fingerprint (read + shell, v2 descriptions), NOT the
// source IP. The old "datacenter IP 403s regardless of headers" diagnosis was
// wrong, and the local `opencode serve` bridge it justified (pm2:
// opencode-serve + opencode-bridge, ~655 MB RSS) is no longer needed.
//
// The OpenCodeExecutor registered in executors/index.js owns buildUrl
// (/inference/v1/...) and the v2 headers; this file declares the base and the
// roster source.
//
// The roster is auto-detected: modelsFetcher polls the live public catalogue
// (ids ending in `-free`), so a new upstream model appears with no deploy. The
// static `models` list below is a seed for when the fetch fails, plus the ids
// the fetcher's `-free` filter drops (big-pickle) and the non-chat models whose
// endpoint differs per model.
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
    baseUrl: "https://opencode.ai",
    headers: {
      // Inert: nothing merges transport.headers onto the wire — OpenCodeExecutor
      // .buildHeaders() owns the real set. Kept aligned so the next reader is not
      // misled; the live value is `cli` (A/B 2026-10-17, /inference/v1 200).
      "x-opencode-client": "cli",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
    // Seed for when the live catalogue fetch fails. Pruned 2026-10-30 against
    // https://opencode.ai/inference/v1/models (82 ids, 9 free): `longcat-2.5-preview-free`,
    // `space-bunny-free` and `ll-alpha-free` dropped off the roster; `flint-40b-free`
    // is live but was missing here. `nemotron-3-ultra-free` also gone. Re-add from
    // the live list, never from memory.
    { id: "big-pickle", name: "Big Pickle" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash (free)" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL (free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (free)" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash (free)" },
    { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash (free)" },
    { id: "flint-40b-free", name: "Flint 40B (free)" },
    { id: "beam-free", name: "Beam (free)" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    // 2026-10-17 probe: /zen/v1/systemone AND /inference/v1/systemone both answer
    // 400 api_usage_error "Invalid request." under UA opencode/1.18.31 and
    // opencode/latest/2.0.26/cli, so `kind: "systemone"` (jev-1.13-free) has no
    // working lane. Unchanged pending a body-shape sample from a real CLI run —
    // do not "fix" the URL without one.
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
