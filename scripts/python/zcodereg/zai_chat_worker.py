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
        row = conn.execute(
            "SELECT email, data FROM providerConnections WHERE provider='zcode' "
            "AND isActive=1 ORDER BY RANDOM() LIMIT 1").fetchone()
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


def _read_reply(page):
    """Extract last assistant reply text (chat-assistant node), strip thought."""
    return page.evaluate("""() => {
      // prefer leaf <p> content inside chat-assistant (final answer)
      const leaves = [...document.querySelectorAll('.chat-assistant p, .chat-assistant [class*="prose"] p')]
        .map(e => (e.innerText || '').trim())
        .filter(t => t.length > 0 && t !== 'Thinking...' && t !== 'Thought Process' && t !== 'Loading...' && !/^[·•.]+$/.test(t));
      if (leaves.length) return leaves.join(' ').trim();
      // fallback: last chat-assistant block text
      const nodes = [...document.querySelectorAll('.chat-assistant, [class*="message-"]')]
        .map(e => (e.innerText || '').trim())
        .filter(t => t.length > 1 && !t.includes('Deep Think'));
      if (!nodes.length) return '';
      const last = nodes[nodes.length - 1];
      const parts = last.split(/\\n+/).filter(s => s.trim() && s.trim() !== 'Thought Process' && s.trim() !== 'Thinking...');
      return parts.length ? parts[parts.length - 1].trim() : last.trim();
    }""")


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


def parse_tool_calls(text):
    """Extract tool calls from model text -> OpenAI tool_calls.

    Handles BOTH:
      - explicit <tool_call>{json}</tool_call> markup
      - bare JSON payload {"name": ..., "arguments": ...} (model emits raw JSON)
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

    # 2) bare JSON payload (whole text or fenced ```json ... ```)
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
        page.wait_for_timeout(6000)
        # dismiss onboarding modal / clean state
        for _ in range(3):
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(700)
            except Exception:
                pass
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
        box = page.query_selector('#chat-input') or page.query_selector('textarea')
        if not box:
            return {"error": "no #chat-input"}
        box.click()
        box.fill(full_prompt)
        page.wait_for_timeout(800)
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
            txt = _read_reply(page)
            if txt and len(txt) > 1 and txt.strip() not in ("Thinking...", "Thought Process", "Loading..."):
                calls = parse_tool_calls(txt) if tools else []
                return {"content": txt, "model": model or "default",
                        "email": acc["email"], "tool_calls": calls}
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