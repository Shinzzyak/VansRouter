#!/usr/bin/env python3
"""ZCode OAuth flow — LOCALHOST callback (persis AuthCodeOAuthClient repo).
- authorize: https://chat.z.ai/api/oauth/authorize?redirect_uri=http://127.0.0.1:<port>/oauth/callback/zai&response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=<state>
- callback GET: /oauth/callback/zai?authCode=...&state=...
- exchange POST zcode.z.ai/api/v1/oauth/token: {provider: zai, code: authCode, redirect_uri, state}
"""
import sys, os, json, time, uuid, sqlite3, urllib.parse, urllib.request, urllib.error, socket, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"

_callback_result = {}
_callback_state = ""


def load_account(email):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    conn.close()
    if not row:
        return None
    d = json.loads(row["data"])
    psd = d.get("providerSpecificData") or {}
    return {"email": row["email"], "token": d.get("accessToken", ""),
            "cookies": psd.get("cookies", [])}


def inject_cookies(ctx, cookies):
    n = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom or ("z.ai" not in dom and "google" not in dom):
            continue
        ck = {"name": c["name"], "value": c["value"]}
        if dom in ("chat.z.ai", "zcode.z.ai", "z.ai"):
            ck["url"] = "https://" + dom
        else:
            ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
            ck["path"] = "/"
        try:
            ctx.add_cookies([ck]); n += 1
        except Exception:
            pass
    return n


class CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        global _callback_result, _callback_state
        u = urllib.parse.urlparse(self.path)
        if u.path != "/oauth/callback/zai":
            self.send_response(404); self.end_headers(); self.wfile.write(b"nf"); return
        q = urllib.parse.parse_qs(u.query)
        state = (q.get("state") or [""])[0]
        code = (q.get("authCode") or q.get("code") or [""])[0]
        if state != _callback_state or not code:
            self.send_response(400); self.end_headers()
            self.wfile.write(b"state mismatch"); return
        _callback_result = {"code": code, "state": state}
        self.send_response(200); self.end_headers()
        self.wfile.write(b"Authorization successful! You may close this window.")
        print(f"[callback] GOT authCode={code[:20]}... state={state[:12]}...", flush=True)


def req(method, url, body=None, auth=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if auth: h["Authorization"] = f"Bearer {auth}"
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="ignore")


def main():
    global _callback_state
    email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
    acc = load_account(email)
    print("email:", acc["email"], "cookies:", len(acc["cookies"]))

    # port tetap (dari env ZCODE_OAUTH_CALLBACK_PORT atau default 3000 — pakai yg di-whitelist server)
    port = int(os.environ.get("ZCODE_OAUTH_CALLBACK_PORT", "3000"))
    _callback_state = uuid.uuid4().hex
    srv = HTTPServer(("127.0.0.1", port), CallbackHandler)
    callback_url = f"http://127.0.0.1:{port}/oauth/callback/zai"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("callback listening:", callback_url)

    auth_url = ("https://chat.z.ai/api/oauth/authorize?"
                f"redirect_uri={urllib.parse.quote(callback_url, safe='')}"
                "&response_type=code"
                "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg"
                f"&state={_callback_state}")
    print("auth_url:", auth_url[:120], "...")

    # Camoufox dengan cookies
    from camoufox.sync_api import Camoufox
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        n = inject_cookies(ctx, acc["cookies"])
        print("cookies injected:", n)
        page = ctx.new_page()
        # track semua navigasi
        def _nav(frame):
            f = frame.url
            if "callback/zai" in f or "authCode" in f or "/oauth/callback" in f:
                print("[nav]", f[:150], flush=True)
        page.on("framenavigated", _nav)
        page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        start = time.time()
        while time.time() - start < 75:
            if _callback_result:
                break
            page.wait_for_timeout(500)
        srv.shutdown()

    if _callback_result.get("code"):
        code = _callback_result["code"]
        st, body = req("POST", "https://zcode.z.ai/api/v1/oauth/token",
                       {"provider": "zai", "code": code, "redirect_uri": callback_url, "state": _callback_state})
        print("EXCHANGE:", st, "|", body[:400])
        try:
            d = json.loads(body)
            jwt = (d.get("data") or {}).get("token") or ""
            zat = ((d.get("data") or {}).get("zai") or {}).get("access_token") or ""
            user = ((d.get("data") or {}).get("user") or {})
            print("JWT len:", len(jwt), "| zai.access_token len:", len(zat), "| user:", user)
            if jwt:
                # save ke DB
                conn = sqlite3.connect(DB)
                row = conn.execute("SELECT data FROM providerConnections WHERE email=?", (email,)).fetchone()
                if row:
                    dd = json.loads(row[0])
                    psd = dd.setdefault("providerSpecificData", {})
                    psd["zcodeJwtToken"] = jwt
                    psd["zcodeOauthTs"] = time.time()
                    if zat: psd["zaiAccessToken"] = zat
                    conn.execute("UPDATE providerConnections SET data=? WHERE email=?", (json.dumps(dd), email))
                    conn.commit()
                conn.close()
                print("JWT SAVED ✓")
        except Exception as e:
            print("parse err:", e)
    else:
        print("NO CODE — callback tidak terima")


if __name__ == "__main__":
    main()