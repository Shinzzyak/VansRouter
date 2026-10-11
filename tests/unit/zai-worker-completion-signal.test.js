/**
 * Regression guard for the zai UI worker's reply-acceptance predicate.
 *
 * Why this exists: the worker accepted a reply as soon as `len(txt) > 1`. That
 * was wrong in BOTH directions, and each direction hid the other (registry §100):
 *
 *   long answer  -> the DOM streams text in chunks, so the first chunk >1 char
 *                   was shipped as the answer. Live-measured: a "count 1..40"
 *                   prompt came back as 25 of 40 lines, HTTP 200, no error.
 *   1-char answer-> 'Z' never passed len>1, so the caller polled until
 *                   timeout_s and got {"error":"timeout waiting for reply"}.
 *
 * The fix accepts only once the turn is over (Stop button gone). This test is a
 * source-shape guard: it cannot re-launch a browser, so it pins the invariant in
 * the code instead. The behavioural proof is probe_partial.py + the two-way
 * negative control recorded in registry §100.5.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(here, "../../scripts/python/zcodereg/zai_chat_worker.py");

const src = readFileSync(WORKER, "utf8");

/** The acceptance branch inside chat_once: from the poll comment to the timeout return. */
function acceptanceBranch(source) {
  const start = source.indexOf("# poll for assistant reply");
  const end = source.indexOf('return {"error": "timeout waiting for reply"');
  if (start === -1 || end === -1) return "";
  return source.slice(start, end);
}

/**
 * Strip `#` comments so assertions match CODE, not prose. Without this the guard
 * false-positives on its own explanatory comment ("the old `len(txt) > 1`
 * predicate was wrong") — verified: that is exactly how the first run failed.
 */
function codeOnly(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .join("\n");
}

const branchCode = codeOnly(acceptanceBranch(src));

describe("zai_chat_worker — reply completion is a turn-over signal, not text length", () => {
  it("defines _generation_finished keyed on the Stop button", () => {
    expect(src).toMatch(/def _generation_finished\(page\)/);
    const fn = src.slice(
      src.indexOf("def _generation_finished(page)"),
      src.indexOf("def chat_once("),
    );
    // the signal must come from the DOM turn state, not from the reply text.
    // NB: the Python source escapes the quotes as `\"Stop\"`, so allow the backslash.
    expect(fn).toMatch(/aria-label\*=\\?"Stop/);
    expect(fn).toMatch(/length === 0/);
  });

  it("does NOT accept a reply on `len(txt) > 1`", () => {
    expect(branchCode.trim()).not.toBe("");
    expect(branchCode).not.toMatch(/len\(txt\)\s*>\s*1/);
    // the old inline placeholder tuple must be hoisted, not duplicated
    expect(branchCode).not.toMatch(/not in \("Thinking\.\.\."/);
  });

  it("gates acceptance on _generation_finished with a non-growing fallback", () => {
    expect(branchCode).toMatch(/_generation_finished\(page\)/);
    // fallback: identical consecutive readings only — never a still-growing one
    expect(branchCode).toMatch(/txt == prev_txt and stable >= 3/);
    expect(branchCode).toMatch(/stable = stable \+ 1 if txt == prev_txt else 0/);
  });

  it("filters the streaming placeholders before the gate", () => {
    expect(src).toMatch(/_PLACEHOLDERS = \("Thinking\.\.\.", "Thought Process", "Loading\.\.\."\)/);
    expect(branchCode).toMatch(/txt\.strip\(\) not in _PLACEHOLDERS/);
  });

  // NEGATIVE CONTROL: the guard must actually reject the shape it was written for.
  it("NEGATIVE CONTROL: the len>1 predicate WOULD be caught by this guard", () => {
    const oldBranch = `
        # poll for assistant reply
        start = time.time()
        while time.time() - start < timeout_s:
            txt = _read_reply(page, after)
            if txt and len(txt) > 1 and txt.strip() not in ("Thinking...", "Thought Process", "Loading..."):
                return {"content": txt}
        return {"error": "timeout waiting for reply", "email": acc["email"]}
`;
    expect(oldBranch).toMatch(/len\(txt\)\s*>\s*1/);
    expect(oldBranch).not.toMatch(/_generation_finished\(page\)/);
    // same two assertions the real test makes, applied to the OLD source:
    expect(() => expect(oldBranch).not.toMatch(/len\(txt\)\s*>\s*1/)).toThrow();
  });
});
