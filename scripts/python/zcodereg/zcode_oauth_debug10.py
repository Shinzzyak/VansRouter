#!/usr/bin/env python3
"""Debug10: authorize dgn Camoufox + cookies + UA Chrome + capture redirect ke localhost."""
import sys, os, json, time, uuid, sqlite3, urllib.parse, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)

_cb = {}
_cb_state = uuid.uuid4().hex


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        st = (q.get("state") or [""])[0]
        code = (q.get("authCode") or q.get("code") or [""])[0]
        print(f"[CB] path={u.path} state_ok={st == _cb_state} code={code[:25]}", flush=True)
        self.send_response(200); self.end_headers()
        self.wfile.write(b"OK"); 
        _cb.update({"code": code, "state": st})


srv = HTTPServer(("127.0.0.1", 3000), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
callback_url = "http://127.0.0.1:3000/oauth/callback/zai"
auth_url = ("https://chat.z.ai/api/oauth/authorize?"
            f"redirect_uri={urllib.parse.quote(callback_url, safe='')}&response_type=code"
            "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=" + _cb_state)

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    # inject UA chrome
    ctx.add_init_script("Object.defineProperty(navigator, 'userAgent', {get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'});")
    n = inject_cookies(ctx, acc["cookies"])
    print("cookies:", n)
    page = ctx.new_page()
    def _nav(frame):
        u = frame.url
        if "callback" in u or "authCode" in u:
            print("[nav]", u[:200], flush=True)
    page.on("framenavigated", _nav)
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    start = time.time()
    while time.time() - start < 75:
        if _cb.get("code"): break
        page.wait_for_timeout(500)
        if time.time() - start > 30:
            print("url now:", page.url[:120], flush=True)
            start2 = time.time()
    print("final url:", page.url[:200])
    print("title:", page.title())
    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,400) : ''")
    print("body:", txt)
srv.shutdown()
print("CB result:", _cb)