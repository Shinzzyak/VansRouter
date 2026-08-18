import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { cleanCookie } from "../utils/cookie.js";
import crypto from "node:crypto";

const CHATGPT_WEB_API = "https://chatgpt.com/backend-api/conversation";
const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const MODEL_MAP = {
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "chatgpt-4o-latest": "gpt-4o",
  "gpt-4-turbo": "gpt-4",
  "gpt-4": "gpt-4",
  "gpt-3.5-turbo": "text-davinci-002-render-sha",
  "o1": "o1",
  "o1-preview": "o1-preview",
  "o1-mini": "o1-mini",
  "o3-mini": "o3-mini",
  "gpt-5": "gpt-5",
};

function formatOpenAIMessagesToPrompt(messages) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => String(c.text || ""))
        .join(" ");
    }
    if (!content.trim()) continue;
    extracted.push({ role, text: content });
  }

  if (extracted.length === 1 && extracted[0].role === "user") {
    return extracted[0].text;
  }

  return extracted.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n\n");
}

export class ChatgptWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", PROVIDERS["chatgpt-web"] || { baseUrl: CHATGPT_WEB_API });
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(
        JSON.stringify({
          error: { message: "Missing or empty messages array", type: "invalid_request" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
      return { response: errResp, url: CHATGPT_WEB_API, headers: {}, transformedBody: body };
    }

    const chatgptModel = MODEL_MAP[model] || model || "gpt-4o";
    const promptText = formatOpenAIMessagesToPrompt(messages);

    const chatgptPayload = {
      action: "next",
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: "user" },
          content: { content_type: "text", parts: [promptText] },
          metadata: {},
        },
      ],
      parent_message_id: crypto.randomUUID(),
      model: chatgptModel,
      timezone_offset_min: -420,
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_paragen_model_slug: "",
      force_nulligen: false,
      force_rate_limit: false,
    };

    const rawToken = credentials?.apiKey || credentials?.accessToken || "";
    const cleanToken = cleanCookie(rawToken, "__Secure-next-auth.session-token");
    const isJwt = cleanToken.split(".").length === 3 || cleanToken.startsWith("eyJ");

    const headers = {
      Accept: "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": CHATGPT_USER_AGENT,
    };

    if (isJwt) {
      headers["Authorization"] = `Bearer ${cleanToken}`;
    } else {
      headers["Cookie"] = `__Secure-next-auth.session-token=${cleanToken};`;
    }

    const accountId =
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const fetchOptions = {
      method: "POST",
      headers,
      body: JSON.stringify(chatgptPayload),
      signal,
    };

    let res;
    try {
      res = await fetch(CHATGPT_WEB_API, fetchOptions);
    } catch (err) {
      log?.error?.("CHATGPT-WEB", `Fetch network error: ${err.message}`);
      const errResp = new Response(
        JSON.stringify({
          error: { message: `ChatGPT upstream network error: ${err.message}`, type: "upstream_error" },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
      return { response: errResp, url: CHATGPT_WEB_API, headers, transformedBody: chatgptPayload };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log?.error?.("CHATGPT-WEB", `HTTP error ${res.status}: ${errText.slice(0, 200)}`);
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `ChatGPT Web error (${res.status}): ${errText.slice(0, 300)}`,
              type: "upstream_error",
              code: res.status,
            },
          }),
          { status: res.status, headers: { "Content-Type": "application/json" } }
        ),
        url: CHATGPT_WEB_API,
        headers,
        transformedBody: chatgptPayload,
      };
    }

    if (stream) {
      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          const text = new TextDecoder().decode(chunk);
          const lines = text.split("\n");

          let lastTextLen = this._lastTextLen || 0;

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              controller.enqueue(new TextEncoder().encode(SSE_DONE));
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const messageObj = parsed.message;
              if (messageObj && messageObj.content && Array.isArray(messageObj.content.parts)) {
                const fullText = messageObj.content.parts.join("");
                if (fullText.length > lastTextLen) {
                  const delta = fullText.slice(lastTextLen);
                  lastTextLen = fullText.length;
                  this._lastTextLen = lastTextLen;

                  const chunkObj = {
                    id: `chatcmpl-${messageObj.id || crypto.randomUUID()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "gpt-4o",
                    choices: [
                      {
                        index: 0,
                        delta: { content: delta },
                        finish_reason: messageObj.status === "finished_successfully" ? "stop" : null,
                      },
                    ],
                  };
                  controller.enqueue(new TextEncoder().encode(sseChunk(chunkObj)));
                }
              }
            } catch {
              // Non-JSON SSE ping/line, skip
            }
          }
        },
        flush(controller) {
          controller.enqueue(new TextEncoder().encode(SSE_DONE));
        },
      });

      const responseStream = res.body.pipeThrough(transformStream);
      return {
        response: new Response(responseStream, {
          status: 200,
          headers: SSE_HEADERS_NO_BUFFER,
        }),
        url: CHATGPT_WEB_API,
        headers,
        transformedBody: chatgptPayload,
      };
    }

    // Non-streaming accumulation
    const fullBody = await res.text();
    const lines = fullBody.split("\n");
    let accumulatedText = "";
    let messageId = crypto.randomUUID();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === "[DONE]") break;
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.message?.content?.parts) {
          accumulatedText = parsed.message.content.parts.join("");
          if (parsed.message.id) messageId = parsed.message.id;
        }
      } catch {
        // ignore
      }
    }

    const nonStreamResp = {
      id: `chatcmpl-${messageId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: accumulatedText },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptText.length / 4,
        completion_tokens: accumulatedText.length / 4,
        total_tokens: (promptText.length + accumulatedText.length) / 4,
      },
    };

    return {
      response: new Response(JSON.stringify(nonStreamResp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: CHATGPT_WEB_API,
      headers,
      transformedBody: chatgptPayload,
    };
  }
}

export default ChatgptWebExecutor;
