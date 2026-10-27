import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";

describe("claudeToOpenAIRequest — stop_sequences dulu hilang", () => {
  const base = { messages: [{ role: "user", content: "halo" }] };

  it("satu stop -> string", () => {
    expect(claudeToOpenAIRequest("gpt-5.2", { ...base, stop_sequences: ["###"] }, false).stop).toBe("###");
  });

  it("banyak stop -> array", () => {
    expect(claudeToOpenAIRequest("gpt-5.2", { ...base, stop_sequences: ["###", "\n\n"] }, false).stop).toEqual(["###", "\n\n"]);
  });

  it("top_p diteruskan", () => {
    expect(claudeToOpenAIRequest("gpt-5.2", { ...base, top_p: 0.3 }, false).top_p).toBe(0.3);
  });

  it("tanpa stop -> field tidak ada", () => {
    expect("stop" in claudeToOpenAIRequest("gpt-5.2", base, false)).toBe(false);
  });
});

describe("geminiToOpenAIRequest — generationConfig dari body dan envelope", () => {
  const contents = [{ role: "user", parts: [{ text: "halo" }] }];

  it("top-level: config, contents, tools, stop, json mode", () => {
    const r = geminiToOpenAIRequest("gpt-5.2", {
      contents,
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        stopSequences: ["##"],
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        seed: 7,
        responseMimeType: "application/json",
      },
      tools: [{ functionDeclarations: [{ name: "cari", description: "cari" }] }],
      systemInstruction: { parts: [{ text: "kamu asisten" }] },
    }, false);

    expect(r.temperature).toBe(0.4);
    expect(r.top_p).toBe(0.9);
    expect(r.stop).toBe("##");
    expect(r.presence_penalty).toBe(0.2);
    expect(r.frequency_penalty).toBe(0.1);
    expect(r.seed).toBe(7);
    expect(r.response_format).toEqual({ type: "json_object" });
    expect(r.tools?.[0]?.function?.name).toBe("cari");
    expect(r.messages[0]).toEqual({ role: "system", content: "kamu asisten" });
    expect(r.messages.at(-1).content).toBe("halo");
  });

  it("envelope {request:{...}} tidak lagi kehilangan isi", () => {
    const r = geminiToOpenAIRequest("gpt-5.2", {
      request: {
        contents,
        generationConfig: { temperature: 0.2 },
        tools: [{ functionDeclarations: [{ name: "hitung" }] }],
      },
    }, false);

    expect(r.temperature).toBe(0.2);
    expect(r.tools?.[0]?.function?.name).toBe("hitung");
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe("halo");
  });
});
