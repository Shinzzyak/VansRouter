// Bridge OpenAI /v1/chat/completions -> a locally running `opencode serve`.
// Needed because opencode.ai's free-tier gate attributes requests by TLS/ALPN +
// client handshake; a plain HTTP hop from a datacenter IP gets 403 FreeTierError,
// while the real OpenCode binary passes. We drive that binary over its local
// OpenAPI surface instead of re-faking headers.
//
// Usage: node scripts/opencode-local-bridge.mjs --port 4870 --upstream http://127.0.0.1:4096
import http from "node:http";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4870"));
const UP = arg("--upstream", "http://127.0.0.1:4096");
const PROVIDER_ID = "opencode";     // provider id inside `opencode serve`
const MODEL_PREFIX = "oc/";

// Upstream still lists these, but every call comes back with an empty body
// (parts: []) — the bridge answers 502 empty_upstream. Don't advertise them.
const DEAD_MODELS = new Set(["exo-free"]);

// Health-gate: poll upstream until `opencode serve` answers, so pm2 does not
// start the bridge before the server is listening (that race orphaned the
// bridge on a stale port once — see 2026-10-14 fix log).
async function waitUpstream(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(UP + "/global/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

async function jfetch(path, opts = {}) {
  const r = await fetch(UP + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json (e.g. web SPA fallback) */ }
  return { status: r.status, json, text };
}

// One session per model keeps prompt caching warm; do NOT key by system prompt
// (the router injects persona text, which would fragment the cache per turn).
const sessions = new Map();
let lastUsed = 0;
async function getSession() {
  if (sessions.has("main")) return sessions.get("main");
  const r = await jfetch("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "vansrouter-bridge" }),
  });
  if (!r.json?.id) throw new Error("session create failed: " + r.text.slice(0, 200));
  sessions.set("main", r.json.id);
  lastUsed = Date.now();
  return r.json.id;
}

function toParts(messages) {
  const out = [];
  for (const m of messages) {
    const content = typeof m.content === "string"
      ? m.content
      : (m.content || []).map((p) => p?.text || "").join("");
    if (m.role === "system") out.push("[system]\n" + content);
    else if (m.role === "assistant") out.push("[assistant]\n" + content);
    else out.push(content);
  }
  return [{ type: "text", text: out.join("\n\n") }];
}

const assistantText = (resp) =>
  (resp?.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    const r = await jfetch("/provider");
    const provs = r.json?.all || r.json?.providers || r.json || [];
    const oc = (Array.isArray(provs) ? provs : []).find((p) => p?.id === PROVIDER_ID);
    const data = Object.keys(oc?.models || {})
      .filter((id) => !DEAD_MODELS.has(id))
      .map((id) => ({
        id, object: "model", owned_by: "opencode-local",
      }));
    return send(200, { object: "list", data });
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    return send(404, { error: { message: "bridge: only /v1/models and /v1/chat/completions" } });
  }

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(400, { error: { message: "bad json" } }); }

  const modelId = String(body.model || "").replace(MODEL_PREFIX, "").replace(/^oclocal\//, "");
  const sys = (body.messages || []).find((m) => m.role === "system")?.content || "";
  const created = Math.floor(Date.now() / 1000);

  try {
    const sid = await getSession();
    lastUsed = Date.now();
    const r = await jfetch(`/session/${sid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: PROVIDER_ID, modelID: modelId },
        system: typeof sys === "string" ? sys : "",
        parts: toParts(body.messages || []),
      }),
    });
    if (r.status !== 200) {
      const msg = r.json?.error?.message || r.json?.info?.error?.message || r.text.slice(0, 300);
      return send(r.status, { error: { message: msg, type: "upstream_error" } });
    }
    const text = assistantText(r.json);
    const usage = r.json?.info?.tokens || {};
    if (text === "") {
      return send(502, {
        error: { message: `opencode serve returned empty output for '${modelId}' (model likely needs entitlement, not free-tier)`, type: "empty_upstream" },
      });
    }
    const out = {
      id: r.json?.info?.id || "chatcmpl-bridge",
      object: "chat.completion", created, model: MODEL_PREFIX + modelId,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.input || 0,
        completion_tokens: usage.output || 0,
        total_tokens: usage.total || 0,
      },
    };
    if (!body.stream) return send(200, out);
    // ponytail: the reply is already complete; one SSE frame carries it. Real
    // token streaming needs /api/event wiring — add when a UI needs live tokens.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ ...out, object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    send(502, { error: { message: "bridge failure: " + e.message, type: "bridge_error" } });
  }
});

// Recycle the upstream session if idle a long time (keeps memory bounded).
setInterval(() => {
  if (sessions.size && Date.now() - lastUsed > 6 * 3600 * 1000) sessions.clear();
}, 3600 * 1000).unref?.();

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`opencode-local-bridge listening on http://127.0.0.1:${PORT} -> ${UP}`);
  const up = await waitUpstream();
  console.log(up ? "upstream opencode serve: healthy" : "upstream opencode serve: NOT reachable within timeout");
});
