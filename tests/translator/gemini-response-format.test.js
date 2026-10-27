import { describe, it, expect } from "vitest";
import { geminiResponseFormat, sanitizeGeminiSchema } from "../../open-sse/translator/concerns/responseFormat.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const messages = [{ role: "user", content: "kasih data" }];

describe("geminiResponseFormat", () => {
  it("json_object -> mimeType saja", () => {
    expect(geminiResponseFormat({ type: "json_object" })).toEqual({ mimeType: "application/json" });
  });

  it("json_schema -> mimeType + schema bersih", () => {
    const out = geminiResponseFormat({
      type: "json_schema",
      json_schema: {
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          properties: { nama: { type: "string", default: "x" } },
          required: ["nama"],
        },
      },
    });
    expect(out.mimeType).toBe("application/json");
    expect(out.schema).toEqual({
      type: "object",
      properties: { nama: { type: "string" } },
      required: ["nama"],
    });
  });

  it("tanpa response_format -> objek kosong", () => {
    expect(geminiResponseFormat(undefined)).toEqual({});
    expect(geminiResponseFormat({ type: "text" })).toEqual({});
  });
});

describe("sanitizeGeminiSchema", () => {
  it("bersih di level bersarang dan di dalam array", () => {
    const input = {
      type: "array",
      items: { type: "object", $comment: "x", properties: { a: { type: "integer", examples: [1] } } },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: "array",
      items: { type: "object", properties: { a: { type: "integer" } } },
    });
  });

  it("tidak memutasi input", () => {
    const input = { type: "object", additionalProperties: false };
    sanitizeGeminiSchema(input);
    expect(input.additionalProperties).toBe(false);
  });
});

describe("openaiToGeminiRequest — field yang dulu hilang", () => {
  it("json mode sampai ke generationConfig", () => {
    const r = openaiToGeminiRequest("gemini-3-pro", { messages, response_format: { type: "json_object" } }, false);
    expect(r.generationConfig?.responseMimeType).toBe("application/json");
  });

  it("json_schema ikut sebagai responseSchema", () => {
    const r = openaiToGeminiRequest(
      "gemini-3-pro",
      { messages, response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { a: { type: "string" } } } } } },
      false,
    );
    expect(r.generationConfig?.responseSchema).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("penalty dan seed diteruskan", () => {
    const r = openaiToGeminiRequest("gemini-3-pro", { messages, presence_penalty: 0.5, frequency_penalty: -0.25, seed: 42 }, false);
    expect(r.generationConfig?.presencePenalty).toBe(0.5);
    expect(r.generationConfig?.frequencyPenalty).toBe(-0.25);
    expect(r.generationConfig?.seed).toBe(42);
  });

  it("nilai bukan angka diabaikan", () => {
    const r = openaiToGeminiRequest("gemini-3-pro", { messages, presence_penalty: "0.5", seed: null }, false);
    expect(r.generationConfig?.presencePenalty).toBeUndefined();
    expect(r.generationConfig?.seed).toBeUndefined();
  });
});
