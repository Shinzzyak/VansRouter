// K31 — usage frames on the streaming path: the deviation is DELIBERATE.
//
// What the router does (measured through the real OpenAI SDK — see
// scratch/d2-sdk-contract.log, and the frames dumped below):
//   - usage rides the FINISH frame (choices length 1), not a separate
//     choiceless frame with choices: []
//   - usage is emitted whether or not the client sent
//     stream_options.include_usage
//
// A strict reading of the OpenAI spec calls both a deviation. They stay because
// the primary consumer (Hermes) SENDS stream_options.include_usage and reads the
// counts off `chunk.usage` (chat_completion_helpers.py: `usage = chunk.usage
// # final usage chunk`), and a strict SDK (openai 2.24.0) accepts both shapes
// without raising.
//
// Gating usage behind include_usage would silently zero out token accounting for
// every client that does not send the flag (0 of 1000 observed requests do).
// This test locks the behaviour so a future "spec cleanup" argues with a red
// test first. It drives createSSEStream() — the real function, not a copy.
//
// Note on the prompt_tokens values: the router intentionally adds a buffer to
// the prompt count before the client sees it (addBufferToUsage). Assertions
// therefore pin the *shape* and the provider's completion count, never the
// buffered prompt number.
import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

function sseChunk(obj) {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

async function runPassthrough(chunks) {
  let finalUsage = null;
  const raw = [];

  const stream = createSSEStream({
    mode: "passthrough",
    provider: "openai-compatible-chat-test",
    model: "",
    connectionId: "conn-k31",
    body: { model: "", messages: [{ role: "user", content: "x" }] },
    onStreamComplete: (_content, usage) => {
      finalUsage = usage;
    },
  });

  const readable = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const reader = readable.pipeThrough(stream).getReader();
  const decoder = new TextDecoder();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw.push(decoder.decode(value, { stream: true }));
  }

  const frames = raw
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return { finalUsage, frames };
}

describe("K31 streaming usage frames — deliberate compatibility deviation", () => {
  it("keeps usage reachable when the client never sent include_usage", async () => {
    // No stream_options anywhere — exactly what all observed traffic does.
    const { finalUsage, frames } = await runPassthrough([
      sseChunk({ id: "k31a", choices: [{ index: 0, delta: { content: "hi" } }] }),
      sseChunk({
        id: "k31a",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 },
      }),
    ]);

    // The contract Hermes depends on: token counts survive the stream.
    expect(finalUsage).not.toBeNull();
    expect(finalUsage.completion_tokens).toBe(12);
    expect(finalUsage.prompt_tokens).toBeGreaterThan(0);

    // And the client can see them too — a frame carries `usage`.
    expect(frames.some((f) => f.usage && f.usage.completion_tokens === 12)).toBe(true);
  });

  it("emits the usage frame attached to a finish frame that still carries choices", async () => {
    const { frames } = await runPassthrough([
      sseChunk({ id: "k31b", choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseChunk({
        id: "k31b",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    ]);

    const usageFrame = frames.find((f) => f.usage);
    expect(usageFrame).toBeDefined();
    // Locked on purpose: usage rides the finish frame. Splitting it into a
    // choiceless frame is a real behaviour change — the SDK accepts both, so it
    // is not a bug fix, and this test must be updated consciously.
    expect(Array.isArray(usageFrame.choices)).toBe(true);
    expect(usageFrame.choices.length).toBeGreaterThan(0);
    expect(usageFrame.choices[0].finish_reason).toBe("stop");
  });

  it("forwards an upstream choiceless usage frame untouched (spec shape)", async () => {
    // Some providers DO send the spec shape: choices: [] plus usage.
    const { frames } = await runPassthrough([
      sseChunk({ id: "k31c", choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseChunk({ id: "k31c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sseChunk({
        id: "k31c",
        choices: [],
        usage: { prompt_tokens: 77, completion_tokens: 3, total_tokens: 80 },
      }),
    ]);

    const choiceless = frames.find((f) => Array.isArray(f.choices) && f.choices.length === 0);
    expect(choiceless).toBeDefined();
    // Forwarded verbatim — no buffering, no field loss on the spec shape.
    expect(choiceless.usage.prompt_tokens).toBe(77);
    expect(choiceless.usage.completion_tokens).toBe(3);
    expect(choiceless.usage.total_tokens).toBe(80);
  });
});
