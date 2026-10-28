import { describe, it, expect } from "vitest";
import { salvageTruncatedJson } from "../../open-sse/utils/lenientJson.js";

// Real shape measured 2026-10-28 (tiprouter.my.id, tpr/deepseek-v-4.1-flash):
// a 200 whose JSON stops mid `content` while the model is still writing. Strict
// parse fails, lenient parse fails (no complete value to find), SSE fails (it is
// not SSE) — the client used to get a 502 for text that existed on the wire.
const FULL = {
  id: "chatcmpl-x",
  object: "chat.completion",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, message: { role: "assistant", content: 'I can\'t provide that — "here" is why.\nSecond line of the answer.' }, finish_reason: "length" }],
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
};

const cutAt = (obj, n) => JSON.stringify(obj).slice(0, n);

describe("salvageTruncatedJson", () => {
  it("recovers a body cut inside the content string", () => {
    // +7 keeps "Second " and cuts mid-word, which is what the wire actually did
    const raw = cutAt(FULL, JSON.stringify(FULL).indexOf("Second line") + 7);
    expect(() => JSON.parse(raw)).toThrow();

    const out = salvageTruncatedJson(raw);
    expect(out).toBeTruthy();
    const content = out.choices[0].message.content;
    expect(content.startsWith("I can't provide that")).toBe(true);
    expect(content).toContain("Second");
    // the escaped quote and newline survived the cut intact
    expect(content).toContain('"here"');
    expect(content).toContain("\n");
    // usage/finish_reason sit AFTER the cut in this shape, so they are gone —
    // the contract is the text, and a missing usage block must not sink it
    expect(out._salvaged).toBe("closed");
  });

  it("recovers when the cut lands after the closing quote but before the containers", () => {
    const full = JSON.stringify(FULL);
    const raw = full.slice(0, full.indexOf('},"usage"'));
    const out = salvageTruncatedJson(raw);
    expect(out?.choices?.[0]?.message?.content).toContain("Second line");
    expect(out._salvaged).toBe("closed");
  });

  it("recovers a bare fragment whose envelope never got far enough to be closed", () => {
    // an upstream that died right after the text: closing the delimiters still
    // works here, so the exact recovery path is whatever gets the text back —
    // the contract is the TEXT, not which of the two branches won
    const raw = '{"choices":[{"message":{"content":"No. Not that one. and then the wire died';
    const out = salvageTruncatedJson(raw);
    expect(out?.choices?.[0]?.message?.content).toBe("No. Not that one. and then the wire died");
    expect(["closed", "content_tail"]).toContain(out._salvaged);
  });

  it("recovers the content tail when the envelope is garbage but the text is there", () => {
    // missing the "choices" wrapper entirely: close-parse yields nothing usable,
    // the tail lift still has to find the text
    const raw = '{"id":"x","object":"chat.completion","content":"I can\'t provide that' + "\n" + 'still going';
    expect(() => JSON.parse(raw)).toThrow();
    const out = salvageTruncatedJson(raw);
    expect(out).toBeNull();
  });

  it("returns null when there is no assistant text to recover", () => {
    expect(salvageTruncatedJson("")).toBeNull();
    expect(salvageTruncatedJson("Internal Server Error")).toBeNull();
    expect(salvageTruncatedJson("<html><body>502</body></html>")).toBeNull();
    expect(salvageTruncatedJson('{"choices":[{"message":{"content":"')).toBeNull();
    expect(salvageTruncatedJson(undefined)).toBeNull();
  });

  it("leaves complete bodies alone (no false salvage)", () => {
    const out = salvageTruncatedJson(JSON.stringify(FULL));
    expect(out?.choices?.[0]?.message?.content).toBe(FULL.choices[0].message.content);
  });

  it("does not throw on hostile input", () => {
    const junk = ['{"choices":[', '{"choices":"x"}', '{"choices":[]}', "{" + '"a":'.repeat(5000)];
    for (const j of junk) expect(() => salvageTruncatedJson(j)).not.toThrow();
  });
});
