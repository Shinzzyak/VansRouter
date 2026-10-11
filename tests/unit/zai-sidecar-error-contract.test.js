/**
 * Regression guard for the zai sidecar's error contract.
 *
 * Why this exists: an exception raised inside the UI worker used to escape
 * `do_POST` completely. BaseHTTPRequestHandler then logged
 * "Exception occurred during processing of request" and wrote NO response at
 * all -- the client got an empty body, not an error JSON. Observed live: one
 * request in a 3-request batch returned nothing and the caller's JSON parse
 * blew up with "Expecting value: line 2 column 1".
 *
 * Two shapes are pinned here:
 *   1. worker  -- the composer click is best-effort. The welcome overlay is
 *      `pointer-events-none` but its CHILDREN still swallow clicks, so a bare
 *      `box.click()` raised `ElementHandle.click: Timeout 30000ms exceeded`
 *      (full traceback in the sidecar journal). `fill()` focuses the element
 *      itself, so a failed click must not abort the request.
 *   2. sidecar -- `do_chat` is wrapped, so any worker exception becomes a clean
 *      502 JSON body instead of a dead connection.
 *
 * Source-shape guard: it cannot launch a browser. Behavioural proof is the
 * live batch (6/6 HTTP 200, zero empty bodies) recorded in registry §100.9.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(here, "../../scripts/python/zcodereg/zai_chat_worker.py");
const SIDECAR = resolve(here, "../../scripts/python/zcodereg/zai_sidecar.py");

const workerSrc = readFileSync(WORKER, "utf8");
const sidecarSrc = readFileSync(SIDECAR, "utf8");

/** Strip `#` comments so assertions match CODE, not prose. */
function codeOnly(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .join("\n");
}

/** The send block inside chat_once: composer lookup through the submit attempt. */
function sendBlock(source) {
  const start = source.indexOf("box = page.query_selector('#chat-input')");
  const end = source.indexOf("_wait_submit_armed(page)");
  if (start === -1 || end === -1) return "";
  return source.slice(start, end);
}

/** The do_chat call site inside do_POST. */
function chatCallBlock(source) {
  const start = source.indexOf("with guard.BROWSER_GATE:");
  // NB: end on the post-call branch, NOT on `guard.note_result(email,` -- the
  // guarded version calls note_result INSIDE the except block, so anchoring
  // there truncates the slice before `self._json(...)` (verified: that is how
  // this guard first failed).
  const end = source.indexOf('if "error" in out:');
  if (start === -1 || end === -1) return "";
  return source.slice(start, end);
}

const sendCode = codeOnly(sendBlock(workerSrc));
const chatCode = codeOnly(chatCallBlock(sidecarSrc));

describe("zai sidecar — a worker failure must never kill the HTTP response", () => {
  it("wraps the composer click so an intercepted click is survivable", () => {
    expect(sendCode.trim()).not.toBe("");
    // must not be a bare, unguarded click
    expect(sendCode).not.toMatch(/^\s*box\.click\(\)\s*$/m);
    expect(sendCode).toMatch(/try:\s*\n\s*box\.click\(/);
    expect(sendCode).toMatch(/except Exception:\s*\n\s*pass/);
  });

  it("bounds the click timeout well below the request timeout", () => {
    const m = sendCode.match(/box\.click\(timeout=(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(5000);
  });

  it("wraps do_chat and answers 502 instead of dying silently", () => {
    expect(chatCode.trim()).not.toBe("");
    expect(chatCode).toMatch(/try:\s*\n\s*out = do_chat\(/);
    expect(chatCode).toMatch(/except Exception as e:/);
    expect(chatCode).toMatch(/_json\(/);
    expect(chatCode).toMatch(/502\)/);
  });

  // NEGATIVE CONTROL: the guard must reject the shapes it was written for.
  it("NEGATIVE CONTROL: the old unguarded shapes WOULD be caught", () => {
    const oldSend = `
        box = page.query_selector('#chat-input') or page.query_selector('textarea')
        if not box:
            return {"error": "no #chat-input"}
        box.click()
        _wait_submit_armed(page)
`;
    const oldChat = `
        with guard.BROWSER_GATE:
            out = do_chat(prompt, model, tools, email=email)
        guard.note_result(email, "error" not in out)
        if "error" in out:
            return self._json({"error": out}, 502)
`;
    const oldSendCode = codeOnly(sendBlock(oldSend));
    const oldChatCode = codeOnly(chatCallBlock(oldChat));
    expect(oldSendCode.trim()).not.toBe("");
    expect(oldChatCode.trim()).not.toBe("");
    expect(oldSendCode).toMatch(/^\s*box\.click\(\)\s*$/m);
    expect(() => expect(oldSendCode).not.toMatch(/^\s*box\.click\(\)\s*$/m)).toThrow();
    expect(oldChatCode).not.toMatch(/except Exception as e:/);
    expect(() => expect(oldChatCode).toMatch(/except Exception as e:/)).toThrow();
  });
});
