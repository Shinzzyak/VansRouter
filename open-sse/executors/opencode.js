import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { randomUUID } from "crypto";
import { resolveSessionId } from "../utils/sessionManager.js";

// OpenCode free tier is limited per egress IP — a 429/403 with a limit-ish
// body means the POOL's IP is exhausted, not the account. Declare it
// pool-scoped so chatCore marks the pool unfit, retries via another pool, and
// it shows up (clearable) on the Proxy Fitness page.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

const OPENCODE_UA = "opencode";
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set(["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return RESPONSES_MODELS.has(baseModelId(model));
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
  _cliHeaders() {
    const enabled = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS === "true";
    if (!enabled) return {};
    const ua = process.env.OPENCODE_CLI_USER_AGENT || "opencode-cli/1.0.0";
    const client = process.env.OPENCODE_CLI_CLIENT || "opencode-cli";
    const project = process.env.OPENCODE_CLI_PROJECT || "vans-router";
    const session = process.env.OPENCODE_CLI_SESSION || randomUUID();
    const requestId = process.env.OPENCODE_CLI_REQUEST || randomUUID();
    return {
      "User-Agent": ua,
      "x-opencode-client": client,
      "x-opencode-project": project,
      "x-opencode-session": session,
      "x-opencode-request": requestId,
    };
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
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
    return {
      "Content-Type": "application/json",
      // Paid/personal key takes priority; "public" is the anonymous free-tier fallback.
      "Authorization": `Bearer ${credentials?.apiKey || credentials?.accessToken || "public"}`,
      "User-Agent": raw["user-agent"]?.toLowerCase().includes("opencode") ? raw["user-agent"] : "opencode",
      "x-opencode-client": raw["x-opencode-client"] || "desktop",
      "x-opencode-session": raw["x-opencode-session"] || credentials?.runtimeOpencodeSession || `ses_${crypto.randomUUID().replaceAll("-", "")}`,
      "x-opencode-request": raw["x-opencode-request"] || `msg_${crypto.randomUUID().replaceAll("-", "")}`,
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
