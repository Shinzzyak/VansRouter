import { describe, it, expect } from "vitest";

import {
  detectCompactRequest,
  buildCompactBody,
  compactHintFromHeaders,
  COMPACT_SYSTEM_PROMPT,
} from "../../open-sse/services/compactEngine.js";

// Build a history long enough to clear MIN_MESSAGES + MIN_BODY_CHARS.
function longHistory(lastUserText, { turns = 10, filler = 1200 } = {}) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `turn ${i} ` + "x".repeat(filler) });
    messages.push({ role: "assistant", content: `reply ${i} ` + "y".repeat(filler) });
  }
  messages.push({ role: "user", content: lastUserText });
  return messages;
}

function headers(map = {}) {
  return { get: (k) => map[k.toLowerCase()] ?? null };
}

describe("detectCompactRequest — protocol flag", () => {
  it("detects the Codex compact endpoint flag", () => {
    const d = detectCompactRequest({ _compact: true, messages: [] }, headers());
    expect(d).toEqual({ compact: true, kind: "codex", via: "flag" });
  });

  it("detects the executor-level _isCompact flag too", () => {
    const d = detectCompactRequest({ _isCompact: true }, headers());
    expect(d.compact).toBe(true);
    expect(d.kind).toBe("codex");
  });

  it("ignores _compact === false", () => {
    const d = detectCompactRequest({ _compact: false, messages: longHistory("hi") }, headers());
    expect(d.compact).toBe(false);
  });
});

describe("detectCompactRequest — explicit header", () => {
  it("honours X-VansRoute-Task: compact", () => {
    const d = detectCompactRequest({ messages: [{ role: "user", content: "x" }] }, headers({ "x-vansroute-task": "compact" }));
    expect(d.compact).toBe(true);
    expect(d.via).toBe("header");
  });

  it("honours the shorter hint headers", () => {
    for (const h of ["x-compact", "x-task"]) {
      expect(compactHintFromHeaders(headers({ [h]: "compact" }))).toBe(true);
      expect(compactHintFromHeaders(headers({ [h]: "summarize" }))).toBe(true);
    }
  });

  it("does not fire on unrelated task values", () => {
    expect(compactHintFromHeaders(headers({ "x-task": "embedding" }))).toBe(false);
    expect(parseDetect({ messages: [] }, headers({ "x-task": "embedding" }))).toBe(false);
  });

  it("header works even on a short body (explicit beats heuristics)", () => {
    const d = detectCompactRequest({ messages: [{ role: "user", content: "short" }] }, headers({ "x-vansroute-task": "compact" }));
    expect(d.compact).toBe(true);
  });
});

function parseDetect(body, hdrs) {
  return detectCompactRequest(body, hdrs).compact;
}

describe("detectCompactRequest — content heuristic", () => {
  it("detects an Antigravity on-demand compaction instruction", () => {
    const body = { messages: longHistory("ON-DEMAND COMPACTION: The user triggered this compaction. Follow any instructions in their latest message.") };
    const d = detectCompactRequest(body, headers());
    expect(d.compact).toBe(true);
    expect(d.via).toBe("instruction");
  });

  it("detects a Hermes-style summarize request", () => {
    const body = { messages: longHistory("Please summarize the conversation so far and preserve all file paths.") };
    expect(detectCompactRequest(body, headers()).compact).toBe(true);
  });

  it("detects Indonesian phrasing", () => {
    const body = { messages: longHistory("Tolong ringkas percakapan kita sampai sekarang.") };
    expect(detectCompactRequest(body, headers()).compact).toBe(true);
  });

  it("detects compaction intent in the Responses API input[] shape", () => {
    const body = { input: longHistory("compact the conversation") };
    const d = detectCompactRequest(body, headers());
    expect(d.compact).toBe(true);
  });

  it("does NOT fire on a long ordinary session", () => {
    const body = { messages: longHistory("now refactor the parser and run the tests") };
    expect(detectCompactRequest(body, headers()).compact).toBe(false);
  });

  it("does NOT fire on a short body even with the instruction", () => {
    const body = { messages: [{ role: "user", content: "summarize the conversation" }] };
    expect(detectCompactRequest(body, headers()).compact).toBe(false);
  });

  it("does NOT fire on an aged-out instruction buried far from the tail", () => {
    const messages = longHistory("carry on with the next step", { turns: 10 });
    messages.splice(2, 0, { role: "user", content: "we should compact the conversation later" });
    expect(detectCompactRequest({ messages }, headers()).compact).toBe(false);
  });
});

describe("buildCompactBody", () => {
  it("injects the compaction system prompt and a final instruction turn", () => {
    const body = { model: "combo/compact", messages: longHistory("now carry on with the migration") };
    const out = buildCompactBody(body, "hermes");
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toBe(COMPACT_SYSTEM_PROMPT);
    expect(out.messages.at(-1).role).toBe("user");
    expect(out.messages.at(-1).content).toMatch(/Compact the conversation/);
  });

  it("adds the instruction turn when detection came from a header, not the text", () => {
    // Header-detected requests carry no compaction instruction in the history,
    // so the engine MUST supply one or the summarizer gets no task at all.
    const body = { messages: longHistory("now carry on with the migration") };
    expect(detectCompactRequest(body, headers()).compact).toBe(false); // no text signal
    const out = buildCompactBody(body, "generic");
    expect(out.messages.at(-1).content).toBe(
      "Compact the conversation above into the briefing format from your instructions. Follow any user instruction about what to focus on, and obey any explicit length limit."
    );
  });

  it("does not mutate the original body", () => {
    const body = { messages: longHistory("compact the conversation") };
    const before = body.messages.length;
    buildCompactBody(body, "generic");
    expect(body.messages.length).toBe(before);
    expect(body.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("strips the client's own system turn so the contract is not outranked", () => {
    const body = {
      messages: [
        { role: "system", content: "you are a coding agent" },
        ...longHistory("compact the conversation"),
      ],
    };
    const out = buildCompactBody(body, "generic");
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(out.messages[0].content).toBe(COMPACT_SYSTEM_PROMPT);
  });

  it("keeps the client's own compaction instruction instead of duplicating it", () => {
    const body = { messages: longHistory("Compaction: summarize the context in 500 words") };
    const out = buildCompactBody(body, "generic");
    const userTurns = out.messages.filter((m) => m.role === "user");
    expect(userTurns.at(-1).content).toMatch(/500 words/);
    expect(out.messages.some((m) => m.content === "Compact the conversation above into the briefing format from your instructions. Follow any user instruction about what to focus on, and obey any explicit length limit.")).toBe(false);
  });

  it("forces non-streaming and drops tools", () => {
    const body = { messages: longHistory("compact the conversation"), stream: true, tools: [{ name: "x" }], tool_choice: "auto" };
    const out = buildCompactBody(body, "generic");
    expect(out.stream).toBe(false);
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });

  it("never lowers a client's own max_tokens", () => {
    expect(buildCompactBody({ messages: longHistory("compact"), max_tokens: 32000 }, "generic").max_tokens).toBe(32000);
    expect(buildCompactBody({ messages: longHistory("compact"), max_tokens: 100 }, "generic").max_tokens).toBe(8192);
  });

  it("handles the contents[] (Vertex) shape", () => {
    const body = { contents: longHistory("compact the conversation") };
    const out = buildCompactBody(body, "generic");
    expect(Array.isArray(out.contents)).toBe(true);
    expect(out.messages).toBeUndefined();
    expect(out.contents[0].role).toBe("system");
  });

  it("returns the body untouched when no history array is present", () => {
    const body = { model: "x", prompt: "compact" };
    expect(buildCompactBody(body, "generic")).toBe(body);
  });

  it("keeps every identifier-bearing message in the history", () => {
    const body = { messages: longHistory("compact the conversation") };
    body.messages.splice(3, 0, { role: "assistant", content: "open-sse/services/compactEngine.js:42 buildCompactBody" });
    const out = buildCompactBody(body, "generic");
    expect(out.messages.some((m) => String(m.content).includes("compactEngine.js:42"))).toBe(true);
  });
});
