#!/usr/bin/env python3
"""ZAI chat worker — drive UI (browser generates signature + captcha).

PROVEN 2026-08-27: UI-driven chat works ("2+2 -> 4"). Manual POST fails
(FRONTEND_CAPTCHA_REQUIRED) because the real X-Signature uses 30+ obfuscated
fingerprint fields in bundle prod-fe-1.1.92. So we let the browser build the
request for us: fill #chat-input, click send, read assistant reply from the
message-<uuid> DOM node.

Usage:
  python3 zai_chat_worker.py [model] [prompt]
  python3 zai_chat_worker.py "glm-5.3-flash" "explain DNS in 2 lines"

Env:
  ZCODE_DB  path to data.sqlite (default VansRouter data/db/data.sqlite)
"""
import sys, os, json, time, sqlite3, uuid, re, threading, queue

DB = os.environ.get("ZCODE_DB", "/home/ubuntu/VansRouter/data/db/data.sqlite")

# Bound on the Camoufox launch itself. Without it the launch is unbounded and it is
# the slowest step on a memory-pressured box (measured 205-209s cold). Playwright's
# default launch timeout is 30s; 45s gives cold starts room without letting a wedged
# launch eat the caller's whole patience.
LAUNCH_TIMEOUT_MS = int(os.environ.get("ZAI_LAUNCH_TIMEOUT_MS", "45000"))


def load_account(email=None):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    if email:
        row = conn.execute(
            "SELECT email, data FROM providerConnections WHERE provider='zcode' AND email=?",
            (email,)).fetchone()
    else:
        # Credential store, not a routing list: no isActive filter (the zc/ path
        # is retired; these rows only exist to hold cookies + tokens by email).
        row = conn.execute(
            "SELECT email, data FROM providerConnections WHERE provider='zcode' "
            "AND email IS NOT NULL ORDER BY RANDOM() LIMIT 1").fetchone()
    conn.close()
    if not row:
        return None
    data = json.loads(row["data"])
    psd = data.get("providerSpecificData") or {}
    return {
        "email": row["email"],
        "token": data.get("accessToken", ""),
        "cookies": psd.get("cookies", []),
    }


def inject_cookies(ctx, cookies):
    n = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom or "z.ai" not in dom:
            continue
        ck = {"name": c["name"], "value": c["value"]}
        if dom == "chat.z.ai":
            ck["url"] = "https://chat.z.ai"  # url+path = rejected by Camoufox
        else:
            ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
            ck["path"] = "/"
        try:
            ctx.add_cookies([ck])
            n += 1
        except Exception:
            pass
    return n


def _assistant_block_count(page):
    """Number of assistant turns currently in the DOM.

    Captured BEFORE a send and handed to _read_reply as `after`, so a reply is
    only ever read from a block that appeared after this send. Without it a
    reused page returns the PREVIOUS turn's answer (proven: probe_stale_read.py
    -> same thread, unrelated question, reply = last answer, 2.37s).
    """
    try:
        return int(page.evaluate("() => document.querySelectorAll('.chat-assistant').length") or 0)
    except Exception:
        return 0


def _read_reply(page, after=0):
    """Extract the assistant reply from blocks at index >= `after`.

    `after=0` reproduces the original cold-path behaviour (every block in the
    document); any other value reads only the fresh turn, which is what makes
    page reuse safe.
    """
    return page.evaluate("""(after) => {
      const clean = (t) => t && t !== 'Thinking...' && t !== 'Thought Process' && t !== 'Loading...' && !/^[·•.]+$/.test(t);
      const blocks = [...document.querySelectorAll('.chat-assistant')];
      const fresh = blocks.slice(after);
      // prefer leaf <p> content inside the fresh assistant blocks (final answer)
      for (let i = fresh.length - 1; i >= 0; i--) {
        const leaves = [...fresh[i].querySelectorAll('p, [class*="prose"] p')]
          .map(e => (e.innerText || '').trim())
          .filter(t => t.length > 0 && clean(t));
        if (leaves.length) return leaves.join(' ').trim();
      }
      if (after === 0) {
        // cold path, unchanged: fall back to the last message-ish node
        const nodes = [...document.querySelectorAll('.chat-assistant, [class*="message-"]')]
          .map(e => (e.innerText || '').trim())
          .filter(t => t.length > 1 && !t.includes('Deep Think'));
        if (!nodes.length) return '';
        const last = nodes[nodes.length - 1];
        const parts = last.split(/\\n+/).filter(s => s.trim() && s.trim() !== 'Thought Process' && s.trim() !== 'Thinking...');
        return parts.length ? parts[parts.length - 1].trim() : last.trim();
      }
      return '';
    }""", after)


# ---- Tool-call helpers (text-markup protocol, ref @ai-sdk-tool/parser) ----

def _render_messages(messages):
    """Render OpenAI chat messages into a single UI prompt (role-labeled), so
    multi-turn tool flows (assistant tool_calls -> tool result -> final answer)
    survive the single-textbox chat.z.ai UI."""
    if not messages:
        return ""
    parts = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
        if role == "tool":
            parts.append(f"[tool result] {content}")
        elif role == "assistant" and m.get("tool_calls"):
            tcs = json.dumps(m["tool_calls"], ensure_ascii=False)
            parts.append(f"[assistant called tools] {tcs}")
        elif role == "assistant":
            parts.append(f"[assistant] {content}")
        else:
            parts.append(f"[user] {content}")
    return "\n".join(parts)


def _tool_spec(tool):
    """Serialize one OpenAI-format tool def into a compact XML spec."""
    fn = tool.get("function", tool)
    name = fn.get("name", "tool")
    desc = fn.get("description", "")
    params = fn.get("parameters", fn.get("input_schema", {}))
    props = params.get("properties", {}) if isinstance(params, dict) else {}
    required = params.get("required", []) if isinstance(params, dict) else []
    lines = [f'<tool name="{name}">']
    if desc:
        lines.append(f"  <description>{desc}</description>")
    for pname, pdef in props.items():
        ptype = pdef.get("type", "string") if isinstance(pdef, dict) else "string"
        preq = " required" if pname in required else ""
        lines.append(f'  <param name="{pname}" type="{ptype}"{preq}/>')
    lines.append("</tool>")
    return "\n".join(lines)


def build_tools_prompt(user_prompt, tools):
    """Inject the XML tool spec into the prompt so the UI-driven model emits
    <tool_call> markup that we can parse back."""
    if not tools:
        return user_prompt
    spec = "\n".join(_tool_spec(t) for t in tools)
    return (
        "You have access to the following functions. If you need one, emit "
        "EXACTLY one <tool_call> block with a JSON body, and nothing else:\n\n"
        f"{spec}\n\n"
        "Format:\n<tool_call>\n{\"name\": \"<function>\", \"arguments\": {<json>}}\n</tool_call>\n\n"
        "Rule: if no tool is needed, answer normally.\n\n"
        "User request:\n"
        f"{user_prompt}"
    )


_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(?:\{.*?\}|.*?)\s*</tool_call>",
    re.DOTALL | re.IGNORECASE,
)
_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)
_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def parse_tool_calls(text):
    """Extract tool calls from model text -> OpenAI tool_calls.

    Handles BOTH:
      - explicit <tool_call>{json}</tool_call> markup
      - bare JSON payload {"name": ..., "arguments": ...} (model emits raw JSON)
      - fenced ```json {...} ``` block
    """
    if not text:
        return []
    calls = []

    def _emit(obj):
        name = obj.get("name")
        if not name:
            return
        args = obj.get("arguments", obj.get("parameters", {}))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {"raw": args}
        args = args if isinstance(args, dict) else {"raw": args}
        calls.append({
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(args, ensure_ascii=False),
            },
        })

    # 1) explicit <tool_call> blocks
    for block in _TOOL_CALL_RE.findall(text):
        m = _JSON_RE.search(block)
        if m:
            try:
                _emit(json.loads(m.group(0)))
            except Exception:
                continue

    # 1b) fenced ```json {...} ```
    if not calls:
        for m in _FENCE_RE.findall(text):
            try:
                obj = json.loads(m)
                if isinstance(obj, dict) and "name" in obj and ("arguments" in obj or "parameters" in obj):
                    _emit(obj)
                    break
            except Exception:
                continue

    # 2) bare JSON payload (whole text or embedded)
    if not calls:
        for candidate in _JSON_RE.findall(text):
            try:
                obj = json.loads(candidate)
            except Exception:
                continue
            if isinstance(obj, dict) and "name" in obj and ("arguments" in obj or "parameters" in obj):
                _emit(obj)
                break  # first valid tool-call wins for a single-turn emit

    return calls


def _dismiss_welcome(page, appear_ms=8000):
    """Click the chat.z.ai welcome overlay's own Close button, if one is up.

    chat.z.ai renders an announcement modal ("Explore the GLM-5.3 ...") that
    swallows the composer: while it is up the submit button never arms, so the
    turn would sit until the reply timeout. The old path cleared it with a fixed
    `wait_for_timeout(6000)` plus 3 blind Escape presses -- 9.5s of stall on EVERY
    request, and Escape is not guaranteed to hit the modal. Clicking the modal's
    own Close button costs ~0.3s and is deterministic.

    The modal is DELAYED and per-account: probed 2026-10-13, it mounts anywhere
    from goto+3.9s to goto+16.7s, or never at all (justin.stewart, emily.campbell
    both showed runs with no modal). No fixed pre-wait can cover that window, so
    this is called only when the composer provably failed to arm -- at which point
    the overlay is up and its Close button already exists, so the poll returns on
    the first pass. `appear_ms` is just a ceiling for the pathological case.
    """
    click_js = """() => {
      for (const o of document.querySelectorAll('div.fixed.inset-0')) {
        if (parseInt(getComputedStyle(o).zIndex || 0) <= 1000) continue;
        const b = [...o.querySelectorAll('button, [role="button"]')]
          .find(x => /^(close|got it|dismiss|skip)$/i.test((x.innerText || x.getAttribute('aria-label') || '').trim()));
        if (b) { b.click(); return 'clicked'; }
      }
      return 'none';
    }"""
    deadline = time.time() + appear_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(click_js) == "clicked":
                page.wait_for_timeout(300)
                return True
        except Exception:
            pass
        page.wait_for_timeout(200)
    # no Close button ever appeared: blind Escape as a last resort
    for _ in range(3):
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(700)
        except Exception:
            pass
    return False


def _composer_covered(page):
    """True when a welcome overlay is sitting on top of the composer.

    The composer renders UNDER the announcement modal, so plain existence is not
    enough -- a fill() aimed at a covered composer lands on the overlay and the
    text never reaches the app.
    """
    js = """() => {
      const e = document.querySelector('#chat-input') || document.querySelector('textarea');
      if (!e) return false;
      const r = e.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !top || !(e === top || e.contains(top) || top.contains(e));
    }"""
    try:
        return bool(page.evaluate(js))
    except Exception:
        return False


def _wait_composer_exists(page, timeout_ms=10000):
    """Wait for the composer node to exist at all. Returns True on success."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(
                    "() => !!(document.querySelector('#chat-input') || document.querySelector('textarea'))"):
                return True
        except Exception:
            pass
        page.wait_for_timeout(200)
    return False


def _wait_submit_armed(page, timeout_ms=8000):
    """Wait until the send button is enabled -- i.e. the app registered the input.

    Costs ~0.1s once the welcome modal is gone (probe_modal_v3.py), so it can
    replace the old flat `wait_for_timeout(800)` settle.
    """
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate("() => { const b = document.querySelector('button[type=\"submit\"]'); return !!b && !b.disabled; }"):
                return True
        except Exception:
            pass
        page.wait_for_timeout(150)
    return False


_PLACEHOLDERS = ("Thinking...", "Thought Process", "Loading...")


def _generation_finished(page):
    """True once the assistant turn is over -- the Stop button is gone.

    This is the ONLY reliable "the answer is complete" signal. Text length is
    not: measured with a 250ms poll (probe_partial.py, 2026-10-11) on a prompt
    asking for 40 lines, the DOM hands out text in chunks --

        17.08s 'Thinking...' (11)   Stop=1
        18.32s 'one\\ntwo\\n...twelve' (62)   Stop=1
        18.98s (284)                Stop=1
        19.45s (360)                Stop=0   <-- turn over, answer complete

    so the old `len(txt) > 1` predicate returned the 62-char mid-stream chunk.
    Live proof: the sidecar answered a 40-line prompt with 25 lines (185 chars,
    ends at "twenty") because it shipped the first chunk it saw.
    """
    try:
        return page.evaluate(
            "() => document.querySelectorAll('[aria-label*=\"Stop\" i]').length === 0")
    except Exception:
        return False


def chat_once(prompt, model=None, email=None, timeout_s=180, tools=None):
    """Cold one-shot turn (CLI + probes): launch a browser, run one turn, close it.

    The HTTP path does NOT use this -- it goes through submit_chat() so the
    Camoufox launch happens once and the browser is reused across turns.
    """
    from camoufox.sync_api import Camoufox
    # t0 is taken BEFORE the turn body, so timeout_s bounds the WHOLE turn
    # (goto + fill + submit + poll), not just the reply poll. Live 2026-10-11
    # 20:03: one request sat 4m44s before the client dropped the socket
    # (BrokenPipeError in the sidecar journal) while the poll loop still believed
    # it was in budget.
    t0 = time.time()
    with Camoufox(headless=True, timeout=LAUNCH_TIMEOUT_MS) as browser:
        return _turn(browser, prompt, model, email, tools, timeout_s, t0)


def _turn(browser, prompt, model, email, tools, timeout_s, t0):
    """One UI chat turn on an ALREADY-LIVE browser.

    A fresh context per turn is deliberate: the pool round-robins accounts, so
    the cookie jar must be per-account. Closing the context releases the page.
    """
    acc = load_account(email)
    if not acc:
        return {"error": "no zcode account"}
    ctx = browser.new_context()
    try:
        inject_cookies(ctx, acc["cookies"])
        page = ctx.new_page()
        try:
            page.goto("https://chat.z.ai", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return {"error": f"goto: {str(e)[:100]}"}
        # fill + send
        full_prompt = build_tools_prompt(prompt, tools)
        after = _assistant_block_count(page)
        _wait_composer_exists(page)
        # A delayed per-account announcement modal mounts at an arbitrary point in
        # the first ~17s after load. It covers the composer AND replaces its node,
        # which wipes whatever was typed -- measured: fill() reported success with
        # the input value back at 0 and the submit button never armed. So retry the
        # whole dismiss/fill/arm sequence rather than trusting a single pass.
        box = None
        for attempt in (1, 2, 3):
            if _composer_covered(page):
                _dismiss_welcome(page)
            box = page.query_selector('#chat-input') or page.query_selector('textarea')
            if not box:
                return {"error": "no #chat-input"}
            # ponytail: click is best-effort only. The welcome overlay is
            # pointer-events-none but its children still swallow clicks, so this
            # raises a 30s TimeoutError on some boots (seen in the sidecar journal).
            # fill() focuses the element itself, so a failed click is survivable.
            try:
                box.click(timeout=3000)
            except Exception:
                pass
            try:
                box.fill(full_prompt)
            except Exception:
                continue
            if _wait_submit_armed(page, timeout_ms=1500):
                break
        else:
            return {"error": "composer never armed", "email": acc["email"]}
        sent = False
        for sel in ['button[type="submit"]', '[data-testid="send-button"]']:
            try:
                s = page.query_selector(sel)
                if s and s.is_visible(timeout=1500):
                    s.click()
                    sent = True
                    break
            except Exception:
                pass
        if not sent:
            page.keyboard.press("Enter")
        # poll for assistant reply (bounded by t0, i.e. the whole-turn deadline)
        prev_txt = None
        stable = 0
        while time.time() - t0 < timeout_s:
            # captcha guard: if slider appeared, solve it
            try:
                has_cap = page.evaluate(
                    "() => !!document.querySelector('#aliyunCaptcha-img, #aliyunCaptcha-sliding-slider, #aliyunCaptcha-captcha-wrapper')")
                if has_cap:
                    from zai_slider import solve_slider_v2
                    solve_slider_v2(page, max_attempts=4)
            except Exception:
                pass
            txt = _read_reply(page, after)
            if txt and txt.strip() not in _PLACEHOLDERS:
                # Accept ONLY once the turn is over. The old `len(txt) > 1`
                # predicate was wrong in both directions:
                #   long answer -> shipped the first mid-stream chunk (25 of 40
                #     lines, live-measured), i.e. TRUNCATED replies
                #   1-char answer -> 'Z' never passed len>1, so the caller
                #     polled the whole timeout_s and got {"error": "timeout"}
                # Fallback: 3 unchanged polls, in case the Stop selector ever
                # stops matching (UI/locale change) -- never accept a growing
                # reading, that is the truncation bug again.
                if _generation_finished(page) or (txt == prev_txt and stable >= 3):
                    calls = parse_tool_calls(txt) if tools else []
                    return {"content": txt, "model": model or "default",
                            "email": acc["email"], "tool_calls": calls}
                stable = stable + 1 if txt == prev_txt else 0
                prev_txt = txt
            page.wait_for_timeout(1000)
        return {"error": "timeout waiting for reply", "email": acc["email"]}
    finally:
        try:
            ctx.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Warm browser: one owner thread + a job queue.
#
# The Playwright sync API is bound to the thread that created the browser, so a
# process-wide browser cannot be shared directly -- behind ThreadingHTTPServer,
# request 2 lands on a different thread and dies with "cannot switch to a
# different thread". One owner thread therefore creates the browser once and
# runs every turn on it; HTTP handlers submit a job and block on the result.
# This deletes the per-request Camoufox launch -- the dominant latency term
# (10-30s warm, 205-209s measured cold) and the memory spike that put the
# unit's peak at 1.4G.
#
# The browser is recycled after RECYCLE_TURNS turns or RECYCLE_SEC seconds so
# the Camoufox fingerprint rotates instead of being pinned to the pool forever
# (every account already shares one IP; a single frozen fingerprint on top of
# that is needless correlation).
# ---------------------------------------------------------------------------
RECYCLE_TURNS = int(os.environ.get("ZAI_BROWSER_RECYCLE_TURNS", "40"))
RECYCLE_SEC = float(os.environ.get("ZAI_BROWSER_RECYCLE_SEC", "1800"))

_JOB_Q = queue.Queue()
_OWNER: dict = {"thread": None}
_OWNER_LOCK = threading.Lock()


def _owner_loop():
    """Owns the Camoufox session for the process lifetime; one turn at a time."""
    from camoufox.sync_api import Camoufox
    cm = None
    browser = None
    turns = 0
    born = 0.0
    while True:
        job = _JOB_Q.get()
        if job is None:
            break
        if job["cancelled"]:
            job["event"].set()
            continue
        if cm is not None and (turns >= RECYCLE_TURNS or time.time() - born > RECYCLE_SEC):
            _teardown(cm)
            cm = browser = None
        try:
            if browser is None:
                cm = Camoufox(headless=True, timeout=LAUNCH_TIMEOUT_MS)
                browser = cm.__enter__()
                turns, born = 0, time.time()
            job["result"] = _turn(browser, job["prompt"], job["model"], job["email"],
                                  job["tools"], job["timeout_s"], time.time())
            turns += 1
        except Exception as e:
            # a wedged or crashed browser must not poison the next turn
            _teardown(cm)
            cm = browser = None
            job["result"] = {"error": f"worker: {type(e).__name__}: {str(e)[:180]}"}
        finally:
            job["event"].set()


def _teardown(cm):
    """Close a Camoufox session; __exit__ also stops its playwright loop."""
    if cm is None:
        return
    try:
        cm.__exit__(None, None, None)
    except Exception:
        pass


def _ensure_owner():
    with _OWNER_LOCK:
        t = _OWNER["thread"]
        if t is None or not t.is_alive():
            t = threading.Thread(target=_owner_loop, name="zai-browser-owner", daemon=True)
            _OWNER["thread"] = t
            t.start()


def submit_chat(prompt, model=None, email=None, timeout_s=150, tools=None, wait_s=None):
    """Run one turn on the warm-browser owner thread; return _turn()'s dict.

    The sidecar calls this while holding BROWSER_GATE, so at most one job is in
    flight and the wait is normally just the turn itself. `wait_s` is a wedge
    backstop: if the owner never answers, fail instead of hanging the gate.
    """
    _ensure_owner()
    job = {"prompt": prompt, "model": model, "email": email,
           "timeout_s": timeout_s, "tools": tools,
           "event": threading.Event(), "result": None, "cancelled": False}
    _JOB_Q.put(job)
    budget = wait_s if wait_s else timeout_s + 30
    if not job["event"].wait(budget):
        job["cancelled"] = True
        return {"error": "worker timeout (no result in %ss)" % budget, "email": email}
    return job["result"] or {"error": "worker returned nothing", "email": email}


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else None
    prompt = sys.argv[2] if len(sys.argv) > 2 else "say hi in one short sentence"
    print(f"[zai-worker] model={model or 'default'} prompt={prompt!r}", flush=True)
    out = chat_once(prompt, model=model)
    if "content" in out:
        print(f"RESULT: {out['content'][:500]}", flush=True)
        return 0
    print(f"ERROR: {json.dumps(out)[:400]}", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())