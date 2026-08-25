import { describe, it, expect } from "vitest";
import {
  detectRefusal,
  classifyStreamHead,
  peekStreamForRefusal,
  reconstructPeekedStream,
  getFramingStrategy,
} from "open-sse/rtk/bypassEngine.js";

describe("detectRefusal tuning", () => {
  it("flags short refusals", () => {
    expect(detectRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(detectRefusal("I cannot provide this information.")).toBe(true);
  });

  it("does NOT flag long responses that merely discuss policy late in the text", () => {
    const long = "Here is a comprehensive analysis of content moderation systems. ".repeat(20) +
      "One common pattern is that a policy restricts certain categories of speech, which analysts should understand.";
    expect(detectRefusal(long)).toBe(false);
  });

  it("still flags refusals that lead the response even if long", () => {
    const long = "I'm sorry, I can't assist with that request. " + "Additional context here. ".repeat(50);
    expect(detectRefusal(long)).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(detectRefusal("SQL injection is a code injection technique used to attack data-driven applications.")).toBe(false);
    expect(detectRefusal("")).toBe(false);
    expect(detectRefusal(null)).toBe(false);
  });
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe("classifyStreamHead", () => {
  it("ok for healthy delta stream", () => {
    const head = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n';
    expect(classifyStreamHead(head)).toBe("ok");
  });

  it("refusal when opening deltas carry refusal text", () => {
    const head = 'data: {"choices":[{"delta":{"content":"I\'m sorry, I can\'t help with that."}}]}\n\n';
    expect(classifyStreamHead(head)).toBe("refusal");
  });

  it("empty when stream finishes with no visible content (output filter)", () => {
    const head = 'data: {"choices":[{"delta":{}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    expect(classifyStreamHead(head)).toBe("empty");
  });
});

describe("peekStreamForRefusal + reconstructPeekedStream", () => {
  it("buffers chunks and reconstructs byte-identical stream", async () => {
    const parts = ['data: {"a":1}\\n\\n', 'data: {"b":2}\\n\\n', "data: [DONE]\\n\\n"];
    const gate = await peekStreamForRefusal(sseResponse(parts), 1000);
    expect(gate.empty).toBe(false);
    expect(gate.chunks.length).toBe(3);

    const reader = reconstructPeekedStream(gate).getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    expect(out).toBe(parts.join(""));
  });

  it("empty for non-stream body", async () => {
    const gate = await peekStreamForRefusal(null, 100);
    expect(gate.empty).toBe(true);
  });
});

describe("model family framing", () => {
  it("gemini-* model names resolve to the gemini family strategy (incl. antigravity-hosted)", () => {
    expect(getFramingStrategy("gemini-cli", "gemini-3.7-flash").name).toBe("persona");
    expect(getFramingStrategy("antigravity", "gemini-2.5-pro").name).toBe("persona");
    expect(getFramingStrategy("vertex", "gemini-1.5-flash").name).toBe("persona");
  });

  it("non-matching models still fall back to provider/default strategy", () => {
    expect(getFramingStrategy("claude", "claude-opus-4-7").name).toBe("persona");
    expect(getFramingStrategy("unknown-provider", "some-model").name).toBe("persona");
  });
});
