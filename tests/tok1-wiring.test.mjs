// TOK1 wiring — the tokenizer profile has to be fed by production traffic, not
// only by its own test corpus. These assertions read the source because the
// failure mode being guarded against is a call site that silently drops the
// request body: the module would keep passing its unit tests while the table
// stayed empty in the field. Source-level is the only place that gap is visible.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const CALL_SITES = [
  ["open-sse/handlers/chatCore/nonStreamingHandler.js", 1],
  ["open-sse/handlers/chatCore/sseToJsonHandler.js", 2],
  ["open-sse/handlers/chatCore/streamingHandler.js", 1],
];

test("TOK1/W1 — every saveUsageStats call site hands over the provider body", () => {
  for (const [file, expected] of CALL_SITES) {
    const src = read(file);
    const calls = src.match(/saveUsageStats\(\{/g) || [];
    assert.equal(calls.length, expected, `${file}: ${calls.length} call sites, expected ${expected}`);
    const withBody = src.match(/saveUsageStats\(\{[^}]*requestBody:/g) || [];
    assert.equal(
      withBody.length,
      expected,
      `${file}: ${withBody.length}/${expected} call sites pass requestBody — the rest learn nothing`
    );
  }
});

test("TOK1/W2 — the comparison uses the body the provider actually saw", () => {
  // finalBody first: it carries the injected system prompt. Falling back to the
  // client body would compare ~7k tokens of injection against a 200-token
  // estimate and read as a 36x calibration error.
  for (const [file] of CALL_SITES) {
    const src = read(file);
    assert.match(
      src,
      /requestBody:\s*finalBody\s*\|\|\s*translatedBody\s*\|\|\s*body/,
      `${file}: requestBody must prefer finalBody`
    );
  }
});

test("TOK1/W3 — the observation is fed the RAW estimate, never the calibrated one", () => {
  const src = read("open-sse/handlers/chatCore/requestDetail.js");
  assert.match(src, /estimatePromptTokens\(requestBody,\s*model,\s*\{\s*calibrate:\s*false\s*\}\)/);
  // A calibrated estimate feeding its own correction is a feedback loop that
  // converges on whatever the first observation said.
  assert.doesNotMatch(src, /estimatePromptTokens\(requestBody,\s*model\)/);
  assert.match(src, /observePrompt\(model,\s*rawEstimate,\s*inTokens\)/);
});

test("TOK1/W4 — learning cannot break a request that already succeeded", () => {
  const src = read("open-sse/handlers/chatCore/requestDetail.js");
  const block = src.slice(src.indexOf("TOK1 — teach"), src.indexOf("const time ="));
  assert.match(block, /try\s*\{/, "observation must sit in a try block");
  assert.match(block, /catch\s*\{\s*\}/, "catch must be empty: fail-open, no rethrow");
});

test("TOK1/W5 — the bundle declares tokenProfile with a full fallback set", () => {
  const src = read("scripts/engine-bundle.mjs");
  assert.match(src, /"tokenProfile",/, "tokenProfile must be in ENGINE_MODULES");
  const block = src.slice(src.indexOf("tokenProfile: {"), src.indexOf("voiceCadence: {"));
  for (const fn of [
    "TOKEN_FAMILIES",
    "factorFor",
    "familyOf",
    "classifyText",
    "estimateTokens",
    "estimatePromptTokens",
    "observePrompt",
    "calibrationTable",
    "resetCalibration",
  ]) {
    assert.match(block, new RegExp(`\\b${fn}:`), `FALLBACKS.tokenProfile missing ${fn}`);
  }
  // Without the bundle the router must behave exactly as it did before TOK1:
  // a flat chars/4 estimate. Anything smarter here would be a second
  // implementation that drifts from the real one.
  assert.match(block, /Math\.floor\(String\(text \?\? ''\)\.length \/ 4\)/);
});

test("TOK1/W6 — the table is exposed for reading, with the rejection count", () => {
  const src = read("src/app/api/engine/state/route.js");
  assert.match(src, /tokenProfile: read\(loaded,\s*"tokenProfile"/);
  assert.match(src, /calibrationTable\(\)/);
});
