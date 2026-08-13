import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { randomUUID } from "crypto";

// Models that use /zen/go/v1/messages (Anthropic/Claude format + x-api-key auth)
const MESSAGES_FORMAT_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

const BASE = "https://opencode.ai/zen/go/v1";

export class OpenCodeGoExecutor extends BaseExecutor {
  constructor() {
    super("opencode-go", PROVIDERS["opencode-go"]);
  }

  // buildUrl runs before buildHeaders in BaseExecutor.execute, cache model here
  buildUrl(model) {
    this._lastModel = model;
    return MESSAGES_FORMAT_MODELS.has(model)
      ? `${BASE}/messages`
      : `${BASE}/chat/completions`;
  }

  // #5997 + #10222: opencode.ai chat (/zen/go/v1) rejects generic client UAs
  // (curl/SDK) from datacenter IPs with 403/FreeUsageLimitError 429. When
  // OPENCODE_SYNTHESIZE_CLI_HEADERS=true, inject the OpenCode CLI identity.
  _cliHeaders() {
    const enabled = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS === "true";
    if (!enabled) return {};
    const ua = process.env.OPENCODE_CLI_USER_AGENT || "opencode-cli/1.0.0";
    const client = process.env.OPENCODE_CLI_CLIENT || "opencode-cli";
    const project = process.env.OPENCODE_CLI_PROJECT || "vans-router";
    return {
      "User-Agent": ua,
      "x-opencode-client": client,
      "x-opencode-project": project,
      "x-opencode-session": process.env.OPENCODE_CLI_SESSION || randomUUID(),
      "x-opencode-request": process.env.OPENCODE_CLI_REQUEST || randomUUID(),
    };
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };

    if (MESSAGES_FORMAT_MODELS.has(this._lastModel)) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    Object.assign(headers, this._cliHeaders());
    return headers;
  }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }
}
