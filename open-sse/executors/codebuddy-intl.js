import { DefaultExecutor } from "./default.js";
import { randomBytes } from "node:crypto";
import {
  neutralizeCodeBuddyChannelIdentity,
  compactOversizedTools,
  captureRotatedToken,
  parseCodeBuddyError,
} from "./codebuddyShared.js";

const REQUIRED_SYSTEM_PROMPT = "You are CodeBuddy Code.";

// The intl gateway started rejecting calls on 2026-10-18 with 400 code 11128
// ("channel verification ... not sent from an official client"). Probes isolated
// the fingerprint the gate actually reads: it is NOT the prompt and NOT the UA
// (IDE, CLI and WorkBuddy all pass) — it is per-conversation attribution
// headers. Without them: 11128. With them: the gate passes and the request is
// evaluated on its merits (11140 = account restricted, 200 = served).
// `msg` on 11128 tells you which check failed; "first message is not system
// prompt" is handled by the system-prompt injection below.
function conversationHeaders() {
  const hex = () => randomBytes(16).toString("hex");
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-Conversation-ID": hex(),
    "X-Conversation-Message-ID": hex(),
    "X-Conversation-Request-ID": hex(),
    "X-Request-ID": hex(),
  };
}

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  async execute(input) {
    const result = await super.execute(input);
    const resp = result instanceof Response ? result : result?.response;
    captureRotatedToken(resp, input.credentials);
    return result;
  }

  buildHeaders(credentials, stream = true) {
    return { ...super.buildHeaders(credentials, stream), ...conversationHeaders() };
  }

  parseError(response, bodyText) {
    return parseCodeBuddyError(response, bodyText);
  }

  transformRequest(model, body, stream, credentials) {
    const input = body && typeof body === "object" ? structuredClone(body) : body;
    const transformed = super.transformRequest(model, input, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // Neutralize third-party CLI identity markers (Claude Code, ZCode) to avoid 11128 WAF block
    const sanitizedMessages = neutralizeCodeBuddyChannelIdentity(transformed.messages);

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(sanitizedMessages) ? sanitizedMessages : [];
    const messages = [{ role: "system", content: REQUIRED_SYSTEM_PROMPT }];
    let requiredPromptSeen = false;
    for (const message of source) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "system" && message.content === REQUIRED_SYSTEM_PROMPT) {
        if (requiredPromptSeen) continue;
        requiredPromptSeen = true;
        continue;
      }
      if (message.role === "user" && typeof message.content === "string") {
        messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        messages.push({ ...message });
      }
    }
    transformed.messages = messages;

    // Compact oversized tools if >64KB to avoid sensitive content rejection
    if (Array.isArray(transformed.tools) && transformed.tools.length > 0) {
      transformed.tools = compactOversizedTools(transformed.tools);
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
