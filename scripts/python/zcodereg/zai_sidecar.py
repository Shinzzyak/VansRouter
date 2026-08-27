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
from zai_chat_worker import (
    load_account,
    inject_cookies,
    _read_reply,
    chat_once,
    build_tools_prompt,
    parse_tool_calls,
)
from zai_quota_fetcher import get_snapshot as quota_snapshot

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


def do_chat(prompt, model=None, tools=None):
    """One UI-driven chat (delegates to worker.chat_once so tool parsing is shared)."""
    return chat_once(prompt, model=model, tools=tools)


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
        if self.path == "/quota":
            return self._json(quota_snapshot())
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
        tools = req.get("tools") or None
        prompt = ""
        for m in messages:
            c = m.get("content", "")
            if isinstance(c, str):
                prompt = c
            elif isinstance(c, list):
                prompt = " ".join(str(p.get("text", "")) for p in c if isinstance(p, dict))
        if not prompt.strip():
            return self._json({"error": "empty prompt"}, 400)
        out = do_chat(prompt, model, tools)
        if "error" in out:
            return self._json({"error": out}, 502)
        msg = {"role": "assistant", "content": None}
        tool_calls = out.get("tool_calls") or []
        if tool_calls:
            msg["tool_calls"] = tool_calls
            finish = "tool_calls"
        else:
            msg["content"] = out["content"]
            finish = "stop"
        # estimate tokens so the router records usage (router drops 0/0)
        est_in = max(1, len(prompt) // 4)
        text_out = out.get("content") or json.dumps(tool_calls)
        est_out = max(1, len(text_out) // 4)
        usage = {"prompt_tokens": est_in, "completion_tokens": est_out,
                 "total_tokens": est_in + est_out}
        completion_id = f"chatcmpl-{uuid.uuid4()}"
        full = {
            "id": completion_id,
            "object": "chat.completion",
            "model": out["model"],
            "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
            "usage": usage,
        }
        # stream=true -> emit SSE (OpenAI chunks) so the router can parse usage
        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            def _sse(obj):
                self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
                self.wfile.flush()

            # first chunk: role
            _sse({"id": completion_id, "object": "chat.completion.chunk",
                  "model": out["model"],
                  "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
            # content chunk
            delta = {"content": out["content"]} if not tool_calls else {"tool_calls": tool_calls}
            _sse({"id": completion_id, "object": "chat.completion.chunk",
                  "model": out["model"],
                  "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
            # final chunk: finish_reason + usage
            _sse({"id": completion_id, "object": "chat.completion.chunk",
                  "model": out["model"],
                  "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                  "usage": usage})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        return self._json(full)


def main():
    port = 8879
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[zai-sidecar] listening :{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()