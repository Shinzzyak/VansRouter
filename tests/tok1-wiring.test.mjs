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

test("TOK1/W7 — no consumer still divides characters by four", () => {
  // The module can be perfect and the number on the dashboard can still be
  // wrong if a consumer keeps the old rule. These two were the last holdouts:
  // the cache's tokensSaved counter and pxpipe's before/after estimate.
  //
  // Comments are stripped first: both files *talk about* /4 in prose, and a
  // scan that cannot tell prose from code would either miss a real regression
  // or fail on a correct file.
  const code = (rel) =>
    read(rel)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  for (const file of ["src/lib/semanticcache/cache.js", "open-sse/rtk/pxpipe.js"]) {
    const src = code(file);
    assert.match(src, /tokenProfile\.js/, `${file}: must import tokenProfile`);
    assert.match(src, /familyOf/, `${file}: must pick a family`);
    assert.doesNotMatch(src, /\/\s*4\b/, `${file}: a value is still divided by the literal four`);
  }

  // pxpipe must divide by a derived divisor, not a constant.
  const px = code("open-sse/rtk/pxpipe.js");
  assert.match(px, /const cpt = charsPerToken\(/, "pxpipe: divisor must be derived per request");
  assert.match(px, /\/\s*cpt\b/, "pxpipe: the conversion must divide by the derived divisor");

  // The cache must keep preferring the authoritative usage block over any
  // estimate — an estimate never overrides what the provider actually billed.
  const cache = code("src/lib/semanticcache/cache.js");
  assert.ok(
    cache.indexOf("usage?.total_tokens") < cache.indexOf("profileTokens("),
    "cache: usage.total_tokens must be checked before the estimate"
  );
  // And the estimate must be handed the model, or every reply bills at the
  // default family's rate regardless of who answered.
  assert.match(cache, /estimateTokens\(entry\.body,\s*entry\.model\s*\|\|\s*request\.model\)/);
});
