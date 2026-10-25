const http = require("http");
const crypto = require("crypto");

const origCreate = http.createServer.bind(http);
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

require("./server.js");

// ── rev55 watermark + heartbeat ────────────────────────────────────────────────
// Loaded from the engine bundle, never from a shim: a server without the bundle
// keeps the pre-rev55 behaviour exactly (no headers, no timer). Everything here
// is fail-open — a watermark is never worth taking a request path down for.
function engineBundle() {
  try {
    return require("./data/engine/engine.cjs");
  } catch (_) {
    return null;
  }
}

const ENGINE = engineBundle();
const LICENCE = ENGINE && ENGINE.licenseGate;
const WATERMARK = ENGINE && ENGINE.watermark;
const HEARTBEAT = ENGINE && ENGINE.heartbeat;

if (LICENCE && WATERMARK && typeof WATERMARK.watermarkHeaders === "function") {
  const origWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function patchedWriteHead(...args) {
    try {
      const status = LICENCE.licenseStatusCached();
      const marks = WATERMARK.watermarkHeaders(status);
      for (const key of Object.keys(marks)) {
        if (!this.hasHeader(key)) this.setHeader(key, marks[key]);
      }
    } catch (_) { /* never break a response for a cosmetic mark */ }
    return origWriteHead.apply(this, args);
  };
}

if (LICENCE && HEARTBEAT && typeof HEARTBEAT.startHeartbeat === "function") {
  try {
    const VERSION = require("./package.json").version;
    const beats = HEARTBEAT.startHeartbeat({
      url: process.env.VANSROUTER_HEARTBEAT_URL || "",
      version: VERSION,
      readStatus: () => LICENCE.licenseStatusCached(),
    });
    // First beat only after the server has had a minute to settle: startup
    // traffic must never compete with a licence ping.
    if (beats.running) {
      const firstMs = Number(process.env.VANSROUTER_HEARTBEAT_FIRST_MS || 60_000);
      const first = setTimeout(() => { beats.beatOnce().catch(() => {}); }, Number.isFinite(firstMs) ? Math.max(0, firstMs) : 60_000);
      if (typeof first.unref === "function") first.unref();
    }
  } catch (_) { /* a heartbeat is a nicety, not a dependency */ }
}
