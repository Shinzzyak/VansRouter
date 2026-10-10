import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { createHash } from "crypto";
import { resolveSessionId } from "../utils/sessionManager.js";
import { applyFingerprintToolNames } from "../utils/opencodeFingerprint.js";

// OpenCode free tier is limited per egress IP — a 429/403 with a limit-ish
// body means the POOL's IP is exhausted, not the account. Declare it
// pool-scoped so chatCore marks the pool unfit, retries via another pool, and
// it shows up (clearable) on the Proxy Fitness page.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

// The free tier additionally gates on request SHAPE, enforced in the Console
// deployment (not in the opencode repo). Measured 2026-09-22 on two independent
// hosts (VPS + Windows black box) against /zen/v1/chat/completions:
//
//   403 FreeTierError  <- missing any ONE of: body.stream===true,
//                         a tool named `bash` + a tool named `read`,
//                         User-Agent `opencode/<>=1.18.0>`,
//                         x-opencode-session of `ses_` + 12 lowercase hex + 14 base62
//   200                <- all four present
//
// Size, header order, x-opencode-client/project/request, proxy egress and
// tool_choice are all irrelevant. A UA below 1.18.0 returns 426
// "OpenCode 1.18.0 or newer is required to use the free tier".
const OPENCODE_MIN_FREE_VERSION = "1.18.0";
// Decoy definition used for the injected fingerprint stubs; only the names are
// checked by the gate, so the model sees tools it has no schema for.
const DECOY_DESCRIPTION = "This tool is currently unavailable and must not be used.";
// The upstream model serves the free tier only when the request is streaming.
// chatCore turns the SSE back into JSON for non-streaming clients.
const OPENCODE_GATE_UA = `opencode/${OPENCODE_MIN_FREE_VERSION}`;

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set(["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);

// Base62, matching @opencode-ai/schema identifier.ts: 12 lowercase-hex timestamp
// chars followed by 14 random base62 chars.
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const GATE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

// `ses_` + 26 chars where the first 12 are lowercase hex. A randomUUID-based id
// (32 hex) is rejected by the gate with the same 403.
function generateSessionId() {
  const ts = Date.now();
  let time = "";
  for (let i = 0; i < 6; i++) {
    time += Number((BigInt(ts) >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let rand = "";
  for (const b of bytes) rand += B62[b % 62];
  return `ses_${time}${rand}`;
}

// The session manager hands back a `randomUUID()+Date.now()` string, which the
// free tier rejects. Re-encode it deterministically so prompt-cache continuity
// is preserved: the same seed always maps to the same gate-valid id.
function toGateSessionId(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  const time = digest.subarray(0, 6).toString("hex"); // 12 lowercase hex chars
  let rand = "";
  for (let i = 0; i < 14; i++) rand += B62[digest[6 + i] % 62];
  return `ses_${time}${rand}`;
}

// A client-supplied session id is only forwarded when it already has the shape
// the gate accepts; anything else would be a guaranteed 403. Returns null when
// the candidate is unusable so the caller can fall back.
function normalizeGateSession(candidate) {
  return typeof candidate === "string" && GATE_SESSION_RE.test(candidate) ? candidate : null;
}

// Decoy shape follows the lane: Responses takes flat entries, Chat Completions
// nests them under `function`, the Messages API uses Anthropic's input_schema form.
function decoyTool(name, shape) {
  if (shape === "claude") {
    return { name, description: DECOY_DESCRIPTION, input_schema: { type: "object", properties: {} } };
  }
  if (shape === "chat") {
    return {
      type: "function",
      function: { name, description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } },
    };
  }
  return { type: "function", name, description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } };
}

// Add the stubs the gate requires. Appended, so the caller's own tools keep
// their indexes — a client streaming tool_calls still sees the ids it sent.
// The rename map is recorded on the body so the response side can hand the
// client its own spellings back (see utils/opencodeFingerprint.js).
function cloakFingerprintTools(body, shape) {
  if (!body || typeof body !== "object") return;
  const hadTools = Array.isArray(body.tools) && body.tools.length > 0;
  applyFingerprintToolNames(body, (name) => decoyTool(name, shape));
  // Responses uses auto once the quartet is supplied; chat requests with no
  // caller tools use none so the injected decoys cannot be selected. Anthropic
  // tool_choice shapes are left to the client.
  if (shape === "responses" && !body.tool_choice) body.tool_choice = "auto";
  else if (shape === "chat" && !hadTools && !body.tool_choice) body.tool_choice = "none";
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return RESPONSES_MODELS.has(baseModelId(model));
}

// Anthropic Messages lane (/zen/v1/messages) — decoys use the input_schema shape.
function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}
export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  // #5997 + #10222: opencode.ai free tier (/zen/v1) returns FreeUsageLimitError
  // 429 for generic client UAs from datacenter IPs. When CLI identity synthesis
  // is enabled, REPLACE any non-CLI UA with the OpenCode CLI identity and add
  // the x-opencode-* identity headers Cloudflare checks on VPS egress.
  //
  // The defaults must NOT reintroduce the identity the free tier rejects: the
  // gate needs `opencode/<version>` with version >= 1.18.0 and a well-formed
  // `ses_` id, and this block runs after buildHeaders() and overwrites both.
  _cliHeaders() {
    const enabled = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS === "true";
    if (!enabled) return {};
    const ua = process.env.OPENCODE_CLI_USER_AGENT || OPENCODE_GATE_UA;
    const client = process.env.OPENCODE_CLI_CLIENT || "cli";
    const project = process.env.OPENCODE_CLI_PROJECT || "global";
    const session = process.env.OPENCODE_CLI_SESSION || this._currentSessionId || generateSessionId();
    const requestId = process.env.OPENCODE_CLI_REQUEST || generateRequestId();
    return {
      "User-Agent": ua,
      "x-opencode-client": client,
      "x-opencode-project": project,
      "x-opencode-session": normalizeGateSession(session) || generateSessionId(),
      "x-opencode-request": requestId,
    };
  }

  transformRequest(model, body, stream, credentials) {
    // resolveSessionId ignores a `generate` override for non-kiro scopes and
    // returns a `randomUUID()+Date.now()` id, so the gate-valid form is derived
    // here instead. The seed keeps the id stable per connection (prompt cache).
    const seed = resolveOpencodeSession(body, credentials);
    this._currentSessionId = toGateSessionId(seed);
    if (credentials) credentials.runtimeOpencodeSession = this._currentSessionId;
    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    // Free-tier gate: the upstream only serves a request that is streaming and
    // that carries the fingerprint tool names. Both are body-level, so they
    // belong here rather than in buildHeaders. Clients that bring their own
    // tools keep them — the decoys are appended and the rename map is recorded
    // on the SAME object chatCore holds, so the response side restores the
    // caller's spellings.
    // injectReasoningContent returns a new body, so the gate fields are applied
    // on the object it receives.
    body.stream = true;
    cloakFingerprintTools(body, isResponsesModel(model) ? "responses" : isMessagesModel(model) ? "claude" : "chat");
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = Object.fromEntries(Object.entries(credentials?.rawHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
    // A caller that already identifies as an OpenCode client keeps its UA; the
    // free tier needs a version >= 1.18.0, and the raw UA is only forwarded when
    // it carries one — otherwise the gate sees no version at all.
    const rawUa = raw["user-agent"];
    const clientUa = rawUa?.toLowerCase().includes("opencode") && /opencode\/\d/.test(rawUa) ? rawUa : null;
    return {
      "Content-Type": "application/json",
      // Paid/personal key takes priority; "public" is the anonymous free-tier fallback.
      "Authorization": `Bearer ${credentials?.apiKey || credentials?.accessToken || "public"}`,
      "User-Agent": clientUa || OPENCODE_GATE_UA,
      "x-opencode-client": raw["x-opencode-client"] || "cli",
      // Session: forward the caller's only when it already matches the gate
      // shape, else the id transformRequest derived (stable per connection).
      "x-opencode-session":
        normalizeGateSession(raw["x-opencode-session"]) ||
        normalizeGateSession(credentials?.runtimeOpencodeSession) ||
        generateSessionId(),
      "x-opencode-request": raw["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": raw["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
      ...this._cliHeaders(),
    };
  }

  parseError(response, bodyText) {
    const status = response?.status || 0;
    const text = String(bodyText || "");
    if ((status === 429 || status === 403) && IP_LIMIT_BODY.test(text)) {
      return {
        status,
        message: text.slice(0, 300) || `OpenCode free limit (${status})`,
        poolScoped: { reason: "ip-limit" },
      };
    }
    return null; // fall through to default parsing
  }
}
