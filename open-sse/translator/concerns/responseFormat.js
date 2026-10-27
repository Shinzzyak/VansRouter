// Concern: OpenAI response_format → Gemini native structured output.
//
// Gemini exposes `generationConfig.responseMimeType` + `responseSchema`. Before
// this module the Gemini translator ignored response_format entirely, so a
// client asking for JSON retried against a Gemini-backed model got prose and a
// parse error (the Claude translator already handles the same field).
//
// Gemini's schema subset is OpenAPI 3.0-ish and rejects JSON-Schema keywords it
// does not know, so the schema is stripped before it is forwarded.
const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "$id", "$comment", "additionalProperties", "strict", "examples", "default"]);

export function sanitizeGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/**
 * @param {object} responseFormat — OpenAI response_format
 * @returns {{mimeType?: string, schema?: object}}
 */
export function geminiResponseFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== "object") return {};
  const type = responseFormat.type;
  const schema = responseFormat.json_schema?.schema;
  if (schema && typeof schema === "object") {
    return { mimeType: "application/json", schema: sanitizeGeminiSchema(schema) };
  }
  if (type === "json_object" || type === "json_schema") {
    return { mimeType: "application/json" };
  }
  return {};
}
