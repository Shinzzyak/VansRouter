#!/usr/bin/env python3
"""ZCode web chat v2 — OpenAI-compatible HTTP sidecar.
Free tier ZCode (z.ai) hanya bisa via web chat v2 (bukan zcode-plan API).
Sidecar ini: OpenAI /v1/chat/completions → chat.z.ai/api/v2/chat/completions.
Ambil kredensial (token+cookies) dari DB providerConnections.
Usage: python3 zcode_sidecar.py [--port 8878] [--db /home/ubuntu/VansRouter/data/db/data.sqlite]
"""
import sys, os, json, time, uuid, sqlite3, urllib.request, urllib.error, urllib.parse, threading, base64, hmac, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.environ.get("ZCODE_DB", "/home/ubuntu/VansRouter/data/db/data.sqlite")
SOLVER = os.environ.get("ZCODE_SOLVER", "http://127.0.0.1:8877/solve")
RELAY = os.environ.get("ZCODE_RELAY", "")  # vercel relay URL utk bypass IP block
FE_VERSION = "prod-fe-1.1.87"
SECRET = "key-@@@@)))()((9))-xxxx&&&%%%%%"

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def _fingerprint():
    """kre() rebuild — sortedPayload + urlParams (fingerprint browser)."""
    ts = int(time.time() * 1000)
    o = {
        "hostname": "chat.z.ai",
        "protocol": "https:",
        "referrer": "https://chat.z.ai/",
        "title": "Z.ai",
        "timezone_offset": str(-time.timezone // 60),
        "local_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "utc_time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "is_mobile": "false",
        "is_touch": "false",
        "max_touch_points": "0",
        "browser_name": "Chrome",
        "os_name": "Windows",
    }
    params = [
        ("timestamp", str(ts)),
        ("requestId", str(uuid.uuid4())),
        ("user_id", ""),  # diisi caller
        ("version", "0.0.1"),
        ("platform", "web"),
        ("token", ""),  # diisi caller
        ("user_agent", "Mozilla/5.0"),
        ("language", "en"),
        ("timezone", "Asia/Shanghai"),
    ] + list(o.items())
    # sortedPayload: entries dari o (bukan params!) di-sort key → join ","
    sorted_payload = ",".join(v for _, v in sorted(o.items()))
    url_params = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params)
    return sorted_payload, url_params, ts

def tre_signature(sorted_payload, message, ts):
    """Tre(sortedPayload, message, ts) — HMAC ganda verified."""
    m = ts // 300000
    msg_b64 = b64u(message.encode())
    h = f"{sorted_payload}|{msg_b64}|{ts}"
    sig1 = hmac.new(SECRET.encode(), str(m).encode(), hashlib.sha256).hexdigest()
    sig = hmac.new(sig1.encode(), h.encode(), hashlib.sha256).hexdigest()
    return sig

# round-robin account pool
_pool = []
_pool_lock = threading.Lock()
_pool_idx = 0

def load_pool():
    global _pool
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode'").fetchall()
    for email, data in rows:
        dd = json.loads(data)
        psd = dd.get("providerSpecificData") or {}
        token = dd.get("accessToken", "")
        cookies = psd.get("cookies", [])
        if token and cookies:
            ck = "; ".join(f"{c['name']}={c['value']}" for c in cookies if str(c.get("domain", "")).endswith("z.ai"))
            _pool.append({"email": email, "token": token, "cookie": ck})
    print(f"[zcode-sidecar] loaded {len(_pool)} accounts", flush=True)

def next_account():
    global _pool_idx
    with _pool_lock:
        if not _pool:
            return None
        acc = _pool[_pool_idx % len(_pool)]
        _pool_idx += 1
        return acc

def solve_captcha():
    req = urllib.request.Request(SOLVER, data=json.dumps({
        "type": "aliyun", "scene_id": "didk33e0", "prefix": "no8xfe",
        "region": "sgp", "timeout_s": 100,
        "proxy": "http://127.0.0.1:40000",
    }).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=150).read())

def _req(url, data=None, headers=None, timeout=45):
    """Request via WARP proxy (IP sama dgn solve captcha)."""
    proxy_handler = urllib.request.ProxyHandler({
        "http": "http://127.0.0.1:40000",
        "https": "http://127.0.0.1:40000",
    })
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(url, data=data, headers=headers)
    return opener.open(req, timeout=timeout)

def create_chat(acc):
    req = urllib.request.Request("https://chat.z.ai/api/v1/chats/new",
        data=json.dumps({"chat": {}, "bot_id": ""}).encode(),
        headers={"Content-Type": "application/json", "Cookie": acc["cookie"],
                 "X-FE-Version": FE_VERSION})
    with _req("https://chat.z.ai/api/v1/chats/new", req.data, {"Content-Type": "application/json", "Cookie": acc["cookie"], "X-FE-Version": FE_VERSION}) as r:
        data = json.loads(r.read())
        return data.get("id") or data.get("data", {}).get("id", "")

def zcode_chat(acc, model, messages, max_tokens=2048, stream=False):
    token = acc["token"]
    sorted_payload, url_params, ts = _fingerprint()
    user_msgs = [m for m in messages if m.get("role") == "user"]
    sig_msg = user_msgs[-1]["content"] if user_msgs else "hi"
    if isinstance(sig_msg, list):
        sig_msg = " ".join(str(p.get("text", "")) for p in sig_msg if isinstance(p, dict))
    rid = str(uuid.uuid4())
    # inject user_id + token ke url_params (token kosong di _fingerprint)
    url_params = url_params.replace("user_id=&", f"user_id={urllib.parse.quote(acc['email'])}&")
    url_params = url_params.replace("token=&", f"token={urllib.parse.quote(token)}&")
    url_params = url_params.replace("requestId=", f"requestId={rid}&dummy=")
    import re as _re
    url_params = _re.sub(r"requestId=[^&]*", f"requestId={rid}", url_params)
    sig = tre_signature(sorted_payload, str(sig_msg)[:200], ts)
    url = f"https://chat.z.ai/api/v2/chat/completions?{url_params}&signature_timestamp={ts}"
    solved = solve_captcha()
    if not solved.get("solved"):
        raise RuntimeError(f"captcha solve failed: {solved.get('error', 'unknown')}")
    captcha_param = solved.get("token", {})  # object, bukan string JSON
    body = {
        "stream": True, "model": model,
        "messages": messages,
        "signature_prompt": str(sig_msg)[:200], "params": {}, "extra": {},
        "features": {}, "variables": {},
        "captcha_verify_param": captcha_param,
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Cookie": acc["cookie"],
                 "X-FE-Version": FE_VERSION, "X-Request-Id": rid,
                 "Authorization": f"Bearer {token}", "X-Signature": sig,
                 "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"})
    with _req(url, req.data, {"Content-Type": "application/json", "Cookie": acc["cookie"],
                              "X-FE-Version": FE_VERSION, "X-Request-Id": rid,
                              "Authorization": f"Bearer {token}", "X-Signature": sig}) as r:
        return r.read().decode()

def parse_sse(text):
    """Parse SSE → openai-style response."""
    content = ""
    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            obj = json.loads(line[6:])
            delta = obj.get("data", {}).get("delta_content", "")
            if delta:
                content += delta
        except Exception:
            continue
    return content

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "accounts": len(_pool)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"bad json: {e}"})
        model = body.get("model", "glm-5.2")
        messages = body.get("messages", [])
        stream = bool(body.get("stream", False))
        max_tokens = int(body.get("max_tokens", 2048) or 2048)
        print(f"[req] model={model} msgs={json.dumps(messages)[:120]} stream={stream} mt={max_tokens}", flush=True)
        acc = next_account()
        if not acc:
            return self._json(503, {"error": "no accounts"})
        try:
            chat_id = create_chat(acc)
            raw = zcode_chat(acc, model, messages, max_tokens, stream)
            if "FRONTEND_CAPTCHA_REQUIRED" in raw:
                # captcha token basi/duplicate — retry sekali dgn solve baru
                print("[retry] captcha required, retrying with fresh token", flush=True)
                raw = zcode_chat(acc, model, messages, max_tokens, stream)
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": f"zcode HTTP {e.code}: {e.read().decode()[:200]}"})
        except Exception as e:
            return self._json(502, {"error": str(e)[:200]})
        content = parse_sse(raw)
        if not content:
            return self._json(502, {"error": f"empty response from zcode: {raw[:150]}"})
        resp = {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
        return self._json(200, resp)

def main():
    port = 8878
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    load_pool()
    if not _pool:
        print("ERROR: no zcode accounts in DB", flush=True)
        return 1
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[zcode-sidecar] listening :{port} ({len(_pool)} accounts)", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
