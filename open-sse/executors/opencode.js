import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { randomUUID } from "crypto";
// OpenCode free tier is limited per egress IP — a 429/403 with a limit-ish
// body means the POOL's IP is exhausted, not the account. Declare it
// pool-scoped so chatCore marks the pool unfit, retries via another pool, and
// it shows up (clearable) on the Proxy Fitness page.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

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

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders() {
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-opencode-client": "desktop",
      "Accept": "text/event-stream",
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
