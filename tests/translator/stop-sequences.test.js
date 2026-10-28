import { describe, it, expect } from "vitest";
import { normalizeStopSequences } from "../../open-sse/translator/concerns/stop.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const messages = [{ role: "user", content: "halo" }];

describe("normalizeStopSequences", () => {
  it("menerima string tunggal", () => {
    expect(normalizeStopSequences("\n\n")).toEqual(["\n\n"]);
  });

  it("menerima array", () => {
    expect(normalizeStopSequences(["###", "\n\n"])).toEqual(["###", "\n\n"]);
  });

  it("buang string kosong dan entri bukan string", () => {
    // "  " (spasi) sah sebagai stop sequence, sama seperti "\n\n" — cuma string
    // kosong yang dibuang.
    expect(normalizeStopSequences(["", "  ", null, 5, "##", []])).toEqual(["  ", "##"]);
    expect(normalizeStopSequences("")).toEqual([]);
    expect(normalizeStopSequences([])).toEqual([]);
  });

  it("undefined/null jadi array kosong", () => {
    expect(normalizeStopSequences(undefined)).toEqual([]);
    expect(normalizeStopSequences(null)).toEqual([]);
  });

  it("dedupe dan batasi empat (plafon Claude)", () => {
    expect(normalizeStopSequences(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeStopSequences(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
  });

  it("spasi dipertahankan apa adanya", () => {
    expect(normalizeStopSequences("  ")).toEqual(["  "]);
  });
});

describe("stop sampai ke upstream (dulu hilang total)", () => {
  it("claude: string -> stop_sequences", () => {
    const r = openaiToClaudeRequest("claude-sonnet-4-6", { messages, stop: "\n\n" }, false);
    expect(r.stop_sequences).toEqual(["\n\n"]);
  });

  it("claude: tanpa stop -> field tidak dikirim", () => {
    const r = openaiToClaudeRequest("claude-sonnet-4-6", { messages }, false);
    expect("stop_sequences" in r).toBe(false);
  });

  it("claude: stop kosong tidak dikirim (400 upstream)", () => {
    expect("stop_sequences" in openaiToClaudeRequest("claude-sonnet-4-6", { messages, stop: "" }, false)).toBe(false);
    expect("stop_sequences" in openaiToClaudeRequest("claude-sonnet-4-6", { messages, stop: [] }, false)).toBe(false);
  });

  it("gemini: array -> generationConfig.stopSequences", () => {
    const r = openaiToGeminiRequest("gemini-3-pro", { messages, stop: ["###", "\n\n"] }, false);
    expect(r.generationConfig?.stopSequences).toEqual(["###", "\n\n"]);
  });

  it("gemini: tanpa stop -> field tidak dikirim", () => {
    const r = openaiToGeminiRequest("gemini-3-pro", { messages }, false);
    expect(r.generationConfig?.stopSequences).toBeUndefined();
  });
});
