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

/** The do_chat call site inside do_POST (the bounded account-retry loop). */
function chatCallBlock(source) {
  const start = source.indexOf("with guard.BROWSER_GATE:");
  // NB: end on the assistant-message assembly that FOLLOWS the give-up branch,
  // NOT on `guard.note_result(email,` -- the guarded version calls note_result
  // INSIDE the except block, so anchoring there truncates the slice before the
  // 502 (verified: that is how this guard first failed).
  const end = source.indexOf('msg = {"role": "assistant"');
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

  // A dead account in the pool used to be the CLIENT's problem: one bad member
  // cost the caller a full timeout and a 502 even though 107 other accounts were
  // fine. The request must walk to the next account before giving up.
  it("retries the next pool account before giving up on the request", () => {
    const retry = codeOnly(sidecarSrc);
    // the loop must exist, must re-pick an account, and must be bounded
    expect(retry).toMatch(/for attempt in range\(ACCOUNT_ATTEMPTS\):\s*\n\s*if attempt and[\s\S]{0,200}?t_attempt = time\.monotonic\(\)\s*\n\s*email, why = _pick_slot\(\)/);
    expect(chatCode).toMatch(/continue/);
    // the 502 must fire only AFTER the except block, never from inside it
    const exceptAt = chatCode.indexOf("except Exception as e:");
    const jsonAt = chatCode.indexOf("_json(");
    expect(exceptAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeGreaterThan(exceptAt);
    expect(chatCode.slice(exceptAt, jsonAt)).not.toMatch(/_json\(/);
    // and it must be a post-loop branch, not an early return
    expect(chatCode).toMatch(/if out is None:[\s\S]*?_json\(/);
  });

  it("bounds the attempt count to a small constant", () => {
    const m = sidecarSrc.match(/ACCOUNT_ATTEMPTS\s*=\s*int\(os\.environ\.get\([^)]*\)\s*or\s*"(\d+)"\)/) ||
              sidecarSrc.match(/ACCOUNT_ATTEMPTS\s*=\s*int\(os\.environ\.get\([^,]+,\s*"(\d+)"\)\)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(2);
    expect(Number(m[1])).toBeLessThanOrEqual(3);
  });

  // Retrying a SLOW failure is not a retry, it is a doubled wait: the buyer-visible
  // symptom was a request that never answered. The retry must be gated on the first
  // attempt having failed fast, so the worst case stays near a single attempt.
  it("only retries when the first attempt failed fast (no doubled worst case)", () => {
    expect(sidecarSrc).toMatch(/ATTEMPT_BUDGET_S\s*=\s*float\(os\.environ\.get\(/);
    // Scope the check to the retry loop body: the constant definition sits earlier in
    // the file, so a whole-file indexOf would prove nothing.
    const loopAt = sidecarSrc.indexOf("for attempt in range(ACCOUNT_ATTEMPTS):");
    const bodyEnd = sidecarSrc.indexOf("if not email:", loopAt);
    expect(loopAt).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(loopAt);
    const body = sidecarSrc.slice(loopAt, bodyEnd);
    // the budget check must sit INSIDE the loop body and BEFORE the account re-pick
    const guardAt = body.indexOf("ATTEMPT_BUDGET_S");
    const pickAt = body.indexOf("_pick_slot()");
    expect(guardAt).toBeGreaterThan(-1);
    expect(pickAt).toBeGreaterThan(guardAt);
    // and it must break out, not continue walking the pool
    expect(body.slice(guardAt, pickAt)).toMatch(/break/);
  });

  it("bounds the browser launch and makes timeout_s a whole-turn deadline", () => {
    // An unbounded launch is what put a live request at 4m44s (client dropped the
    // socket) while the reply poll still thought it was in budget.
    expect(workerSrc).toMatch(/LAUNCH_TIMEOUT_MS\s*=\s*int\(os\.environ\.get\(/);
    expect(workerSrc).toMatch(/Camoufox\(headless=True,\s*timeout=LAUNCH_TIMEOUT_MS\)/);
    const t0At = workerSrc.indexOf("t0 = time.time()");
    const launchAt = workerSrc.indexOf("with Camoufox(headless=True, timeout=LAUNCH_TIMEOUT_MS)");
    const pollAt = workerSrc.indexOf("while time.time() - t0 < timeout_s:");
    expect(t0At).toBeGreaterThan(-1);
    expect(launchAt).toBeGreaterThan(t0At);
    expect(pollAt).toBeGreaterThan(launchAt);
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
        msg = {"role": "assistant", "content": None}
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
