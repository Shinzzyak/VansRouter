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
import sys, os, json, time, sqlite3, uuid, re

DB = os.environ.get("ZCODE_DB", "/home/ubuntu/VansRouter/data/db/data.sqlite")


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
    """Close the chat.z.ai welcome overlay so the composer actually arms.

    chat.z.ai renders a welcome modal at z=10000 ("New / GLM-5.3-Flash -- A new
    native multimodal model...") that swallows the composer: measured, the submit
    button NEVER arms while it is up ("submit armed at goto+NEVER" over 25s with
    no interaction). The old path cleared it with a fixed `wait_for_timeout(6000)`
    plus 3 blind Escape presses -- 9.5s of stall on EVERY request, and Escape is
    not guaranteed to hit the modal. Clicking the modal's own Close button costs
    ~2s and is deterministic (probe_modal_v3.py: 21.5s avg vs 26.1s old).

    Escape presses are kept as a fallback for the no-Close-button case.
    """
    js = """() => {
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
            if page.evaluate(js) == "clicked":
                page.wait_for_timeout(300)
                return True
        except Exception:
            pass
        page.wait_for_timeout(200)
    for _ in range(3):
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(700)
        except Exception:
            pass
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
    acc = load_account(email)
    if not acc:
        return {"error": "no zcode account"}
    from camoufox.sync_api import Camoufox
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        inject_cookies(ctx, acc["cookies"])
        page = ctx.new_page()
        try:
            page.goto("https://chat.z.ai", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return {"error": f"goto: {str(e)[:100]}"}
        _dismiss_welcome(page)
        # optional: select model (defaults to top model if omitted)
        if model:
            try:
                btn = page.query_selector('button:has-text("GLM"), [class*="model-select"]')
                # model dropdown exists but leaving default is fine for now
                pass
            except Exception:
                pass
        # fill + send
        full_prompt = build_tools_prompt(prompt, tools)
        after = _assistant_block_count(page)
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
        box.fill(full_prompt)
        _wait_submit_armed(page)
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
        # poll for assistant reply
        start = time.time()
        prev_txt = None
        stable = 0
        while time.time() - start < timeout_s:
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