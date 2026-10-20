// K206 wiring — the credit rule only works if the call sites actually ask it.
//
// `acceptedClass()` can be perfect and still change nothing: the bug was a
// recording site that wrote the classifier's verdict BEFORE the acceptance
// verdict existed. This test reads the handler source, so deleting the call
// site (or moving it back above the verdict) turns the suite red instead of
// silently returning the ledger to `wins={}`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, "../open-sse/handlers/chatCore.js"), "utf8");

test("K206/W1 — the handler imports the credit rule", () => {
  assert.match(SRC, /import \{[^}]*\bacceptedClass\b[^}]*\} from "\.\.\/rtk\/selfMeasuringBypass\.js"/);
});

test("K206/W2 — the non-streaming ladder credits on acceptance, not on class", () => {
  assert.match(SRC, /recordOutcome\(model, lvl2, acceptedClass\(lvl2, cls2, !retryStillRefusal\), ledgerKey\)/);
  // The pre-K206 line recorded the class before `retryStillRefusal` existed.
  assert.doesNotMatch(SRC, /recordOutcome\(model, lvl2, cls2, ledgerKey\)/);
});

test("K206/W3 — the streaming ladder credits on acceptance too", () => {
  assert.match(SRC, /recordOutcome\(model, lvl3, acceptedClass\(lvl3, cls3, retryDelivered\), ledgerKey\)/);
  assert.doesNotMatch(SRC, /recordOutcome\(model, lvl3, cls3, ledgerKey\)/);
});

test("K206/W4 — the record call sits AFTER the verdict it depends on", () => {
  for (const [verdict, call] of [
    ["const retryStillRefusal =", "acceptedClass(lvl2, cls2, !retryStillRefusal)"],
    ["const retryDelivered = Boolean(retryRaw)", "acceptedClass(lvl3, cls3, retryDelivered)"],
  ]) {
    const v = SRC.indexOf(verdict);
    const c = SRC.indexOf(call);
    assert.ok(v > -1, `verdict anchor missing: ${verdict}`);
    assert.ok(c > -1, `call missing: ${call}`);
    assert.ok(c > v, `${call} must be recorded after ${verdict}`);
  }
});
