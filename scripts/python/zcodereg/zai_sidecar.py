#!/usr/bin/env python3
"""ZAI OpenAI-compatible sidecar — UI-driven chat (signature+captcha handled by browser).

Exposes:
  GET  /v1/models            -> list GLM models
  POST /v1/chat/completions  -> non-stream UI chat, OpenAI format
  GET  /health               -> {"ok":true,"accounts":N}

Runs on stdlib http.server (no fastapi dep). Round-robin over zcode accounts.

Why UI-driven: chat.z.ai bundle prod-fe-1.1.92 signs requests with a 30+
field obfuscated fingerprint (X-Signature) that the browser computes; manual
POST always trips FRONTEND_CAPTCHA_REQUIRED. The Camoufox browser builds the
request itself, so we fill #chat-input, send, and read the assistant reply
from the .chat-assistant DOM node. PROVEN: "2+2" -> "4", "12*12" -> "144".

Usage: python3 zai_sidecar.py [--port 8879]
"""
import sys, os, json, time, sqlite3, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zai_chat_worker import load_account, inject_cookies, _read_reply

DB = os.environ.get("ZCODE_DB", "/home/ubuntu/VansRouter/data/db/data.sqlite")
MODELS = [
    {"id": "glm-5.2", "object": "model"},
    {"id": "glm-5.3-flash", "object": "model"},
    {"id": "glm-4.5v", "object": "model"},
    {"id": "glm-4-flash", "object": "model"},
    {"id": "glm-4-air-250414", "object": "model"},
    {"id": "GLM-4.1V-Thinking-FlashX", "object": "model"},
    {"id": "glm-4.6v", "object": "model"},
]

_rr = 0
_rr_lock = threading.Lock()


def next_account():
    """Round-robin over active zcode accounts."""
    global _rr
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT email FROM providerConnections WHERE provider='zcode' AND isActive=1"
    ).fetchall()
    conn.close()
    if not rows:
        return None
    with _rr_lock:
        email = rows[_rr % len(rows)]["email"]
        _rr += 1
    return email


def do_chat(prompt, model=None):
    """One UI-driven chat. Returns dict {content, model, email} or {error}."""
    email = next_account()
    if not email:
        return {"error": "no active zcode account"}
    acc = load_account(email)
    if not acc:
        return {"error": "account load failed"}
    from camoufox.sync_api import Camoufox
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        inject_cookies(ctx, acc["cookies"])
        page = ctx.new_page()
        try:
            page.goto("https://chat.z.ai", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return {"error": f"goto: {str(e)[:80]}"}
        page.wait_for_timeout(6000)
        for _ in range(3):
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(600)
            except Exception:
                pass
        box = page.query_selector('#chat-input') or page.query_selector('textarea')
        if not box:
            return {"error": "no input box"}
        box.click()
        box.fill(prompt)
        page.wait_for_timeout(700)
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
        start = time.time()
        while time.time() - start < 180:
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
                return {"content": txt, "model": model or "default", "email": email}
            page.wait_for_timeout(1000)
        return {"error": "timeout", "email": email}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            conn = sqlite3.connect(DB)
            n = conn.execute("SELECT COUNT(*) FROM providerConnections WHERE provider='zcode' AND isActive=1").fetchone()[0]
            conn.close()
            return self._json({"ok": True, "accounts": n})
        if self.path == "/v1/models" or self.path == "/models":
            return self._json({"object": "list", "data": MODELS})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            return self._json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(body.decode())
        except Exception:
            return self._json({"error": "bad json"}, 400)
        messages = req.get("messages", [])
        model = req.get("model")
        prompt = ""
        for m in messages:
            c = m.get("content", "")
            if isinstance(c, str):
                prompt = c
            elif isinstance(c, list):
                prompt = " ".join(str(p.get("text", "")) for p in c if isinstance(p, dict))
        if not prompt.strip():
            return self._json({"error": "empty prompt"}, 400)
        out = do_chat(prompt, model)
        if "content" in out:
            return self._json({
                "id": f"chatcmpl-{uuid.uuid4()}",
                "object": "chat.completion",
                "model": out["model"],
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": out["content"]},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })
        return self._json({"error": out}, 502)


def main():
    port = 8879
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[zai-sidecar] listening :{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()