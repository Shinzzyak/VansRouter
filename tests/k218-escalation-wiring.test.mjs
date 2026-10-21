// K218 wiring — the escalation loop has to be graded by the ESCALATION rule,
// not by the general "is this class worth another try" rule.
//
// This is a source-level test on purpose. The failure it guards against is a
// call site that keeps importing the old predicate: `selfMeasuringBypass` would
// keep passing its own unit tests while every escalated answer was still being
// thrown away as a refusal. Measured 2026-10-21 in production logs:
//
//   escalation T2 -> AMBIGU   27      escalation .* successful   0
//   escalation T3 -> AMBIGU   23      wins (model level)        {}
//   escalation T1 -> AMBIGU   22
//
// Comments are stripped before scanning: chatCore *talks about* `needsAnotherTry`
// in prose (the K25 sibling note), and a scan that cannot tell prose from code
// would fail on a correct file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const CORE = "open-sse/handlers/chatCore.js";
const SHIM = "open-sse/rtk/selfMeasuringBypass.js";

test("K218/W1 — both escalation verdicts use the evidence rule", () => {
  const src = code(CORE);
  // The two places a fresh escalated attempt is graded.
  const more = src.match(/needsMoreEscalation\(cls[23]\)/g) || [];
  assert.equal(more.length, 2, `expected 2 needsMoreEscalation verdicts, found ${more.length}`);
  // And no escalated attempt is graded by the general rule any more.
  const wrong = src.match(/needsAnotherTry\(cls[23]\)/g) || [];
  assert.equal(wrong.length, 0, `needsAnotherTry still grades an escalated attempt: ${wrong.join(", ")}`);
});

test("K218/W2 — both credit sites use escalationClass", () => {
  const src = code(CORE);
  const credited = src.match(/escalationClass\(lvl[23],/g) || [];
  assert.equal(credited.length, 2, `expected 2 escalationClass credit sites, found ${credited.length}`);
  // acceptedClass has no business here any more: on the escalation path the
  // failed baseline IS the evidence, so the L-only restriction it encodes
  // (K206) would keep a static level from ever being credited for a rescue.
  const stale = src.match(/acceptedClass\(/g) || [];
  assert.equal(stale.length, 0, `acceptedClass still used in chatCore: ${stale.length}`);
});

test("K218/W3 — the import block actually carries the new exports", () => {
  const src = code(CORE);
  const imp = src.match(/^import \{[^}]*\} from "\.\.\/rtk\/selfMeasuringBypass\.js";$/m);
  assert.ok(imp, "selfMeasuringBypass import line not found");
  assert.ok(/needsMoreEscalation/.test(imp[0]), "needsMoreEscalation missing from import");
  assert.ok(/escalationClass/.test(imp[0]), "escalationClass missing from import");
});

test("K218/W4 — a bundle-less router degrades instead of crashing", () => {
  // Every engine export is re-exported through the shim with a no-op fallback.
  // A missing fallback is a `undefined` at the call site, which is a TypeError
  // in the request path — the Zero Break Guarantee broken by a feature flag.
  const shim = code(SHIM);
  assert.ok(
    /export const needsMoreEscalation = __E\.needsMoreEscalation \?\?/.test(shim),
    "needsMoreEscalation has no fallback in the shim",
  );
  assert.ok(
    /export const escalationClass = __E\.escalationClass \?\?/.test(shim),
    "escalationClass has no fallback in the shim",
  );
});
