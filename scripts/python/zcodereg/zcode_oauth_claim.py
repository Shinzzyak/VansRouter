#!/usr/bin/env python3
"""ZCode OAuth claim flow (single account test) — Camoufox UI OAuth + claim.

Flow (mirrors zcode-api repo auth/oauth.ts):
  1. Open chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg
     &redirect_uri=http://127.0.0.1:<port>/callback&response_type=code&state=<state>
     in Camoufox with the account's chat.z.ai cookies injected.
  2. If already logged in (cookie session), provider redirects with ?code=...
     to our localhost callback server.
  3. Exchange code at https://zcode.z.ai/api/v1/oauth/token
     {provider:"zai", code, redirect_uri, state} -> {code:0, data:{token:JWT, zai:{access_token}, user}}
  4. Claim weekend plan with X-Aliyun-Captcha (if needed) or direct.

Usage: python3 zcode_oauth_claim.py <email> [--plan zcode-v3-start-plan-0828]
"""
import sys, os, json, time, uuid, base64, sqlite3, threading, urllib.parse, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize"
TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token"
APP_ID = "client_lS94_Ka2ycE9IwCNYisudg"
PLAN_ID = "zcode-v3-start-plan-0828"
APP_VERSION = "3.10.0"
PLATFORM = "win32-x64"
DEVICE_MID = str(uuid.uuid4())

_callback_result = None
_callback_server = None


def load_account(email):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT email, data FROM providerConnections WHERE provider='zcode' AND email=?",
        (email,)).fetchone()
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
        if dom == "chat.z.ai":
            ck["url"] = "https://chat.z.ai"
        else:
            ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
            ck["path"] = "/"
        try:
            ctx.add_cookies([ck])
            n += 1
        except Exception:
            pass
    return n


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _callback_result
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if u.path not in ("/callback", "/oauth/callback/zai"):
            self.send_response(404); self.end_headers(); return
        qs = parse_qs(u.query)
        code = (qs.get("code") or qs.get("authCode") or [""])[0]
        state = (qs.get("state") or [""])[0]
        _callback_result = {"code": code, "state": state}
        body = b"Authorization successful! You may close this window."
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def start_callback():
    global _callback_server
    _callback_server = HTTPServer(("127.0.0.1", 0), CallbackHandler)
    port = _callback_server.server_address[1]
    threading.Thread(target=_callback_server.serve_forever, daemon=True).start()
    return port


def exchange_code(code, redirect_uri, state):
    import urllib.request
    body = json.dumps({"provider": "zai", "code": code,
                       "redirect_uri": redirect_uri, "state": state}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def claim_plan(jwt, plan_id=PLAN_ID, captcha=None):
    import urllib.request
    headers = {
        "Authorization": "Bearer " + jwt,
        "Content-Type": "application/json",
        "User-Agent": "ZCode/3.10.0",
        "X-ZCode-App-Version": APP_VERSION,
        "X-Platform": PLATFORM,
        "X-Title": "Z Code@cli",
        "X-ZCode-Agent": "glm",
        "X-Release-Channel": "production",
        "X-Client-Language": "en-US",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows",
        "X-Os-Version": "10.0.22631",
        "X-Device-Mid": DEVICE_MID,
        "HTTP-Referer": "https://zcode.z.ai",
    }
    if captcha:
        headers["X-Aliyun-Captcha-Verify-Param"] = captcha
    req = urllib.request.Request("https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
                                 data=json.dumps({"plan_id": plan_id}).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def main():
    global _callback_result
    email = sys.argv[1] if len(sys.argv) > 1 else None
    acc = load_account(email) if email else load_account(None)
    if not acc:
        print("NO ACCOUNT"); return 1

    from camoufox.sync_api import Camoufox
    state = uuid.uuid4().hex
    # redirect_uri yang TERDAFTAR untuk client_lS94 = https://z.ai/subscribe
    # (dari bundle chat.z.ai: ySe prod). Kita tangkap code= dari final URL.
    redirect_uri = "https://z.ai/subscribe"

    auth_url = (f"{AUTHORIZE_URL}?client_id={APP_ID}"
                f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
                f"&response_type=code&state={state}")

    print(f"[oauth] {acc['email']} redirect={redirect_uri}")
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        inj = inject_cookies(ctx, acc["cookies"])
        print(f"[oauth] injected {inj} cookies")
        page = ctx.new_page()
        _captured = {}
        def _on_nav(frame):
            u = frame.url
            if "code=" in u or "authCode=" in u:
                _captured["url"] = u
        page.on("framenavigated", _on_nav)
        try:
            page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(8000)
            # TUNGGU redirect ke z.ai/subscribe atau localhost callback
            for i in range(30):
                if _captured.get("url"):
                    break
                page.wait_for_timeout(1000)
            final_url = _captured.get("url", page.url)
            print("[oauth] captur url:", final_url[:250])
            # extract code dari URL
            import urllib.parse as up
            if "?" in final_url:
                qu = up.parse_qs(up.urlparse(final_url).query)
                code = (qu.get("code") or qu.get("authCode") or [None])[0]
            else:
                code = None
            if code:
                _callback_result = {"code": code, "state": state}
                print(f"[oauth] GOT CODE: {code[:40]}...")
            with open("/tmp/zcode_oauth_state.json", "w") as f:
                json.dump({"email": acc["email"], "url": final_url, "state": state,
                           "redirect_uri": redirect_uri, "code": code,
                           "ts": time.time()}, f)
        except Exception as e:
            print("[oauth] goto err:", str(e)[:100])
            return 1

    # tunggu callback (callback server main; jika redirect ke z.ai/subscribe,
    # code ditangkap dari final URL browser — sudah diset di _callback_result)
    for i in range(30):
        if _callback_result:
            break
        time.sleep(1)
    if not _callback_result:
        print("[oauth] NO CALLBACK (login required atau redirect ke google)")
        return 2

    code = _callback_result["code"]
    print(f"[oauth] code={code[:40]}...")
    res = exchange_code(code, redirect_uri, state)
    print("[oauth] exchange code:", res.get("code"), "| msg:", res.get("msg", ""))
    data = res.get("data") or {}
    jwt = data.get("token") or ""
    print("[oauth] jwt len:", len(jwt))
    if jwt:
        # SAVE ke DB
        conn = sqlite3.connect(DB)
        row = conn.execute("SELECT data FROM providerConnections WHERE email=?",
                           (acc["email"],)).fetchone()
        if row:
            d = json.loads(row[0])
            psd = d.setdefault("providerSpecificData", {})
            psd["zcodeJwt"] = jwt
            psd["zcodeOAuthState"] = {"state": state, "ts": time.time()}
            conn.execute("UPDATE providerConnections SET data=? WHERE email=?",
                         (json.dumps(d), acc["email"]))
            conn.commit()
        conn.close()
        print("[oauth] JWT saved to DB")
        # CLAIM
        st, j = claim_plan(jwt)
        print(f"[claim] status={st} body={json.dumps(j)[:400]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())