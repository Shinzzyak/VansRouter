#!/usr/bin/env python3
"""ZCode Weekend Build Claim — full pipeline (bulk-ready).

Pipeline per akun:
  1. z/login -> biz token (api.z.ai api/auth/z/login)
  2. OAuth authorize via Camoufox (client_lS94 + redirect z.ai/subscribe)
     - intercept navigasi `z.ai/login/callback?code=...` sebelum dikonsumsi
     - tangkap code dari URL
  3. exchange code -> zcode JWT (zcode.z.ai/api/v1/oauth/token)
  4. claim plan (zcode.z.ai/api/v1/zcode-plan/billing/claim)

Bulk: python3 zcode_weekend_claim.py --all    (loop 108 akun)
Test:  python3 zcode_weekend_claim.py justin.stewart@e-mail.bty.web.id
"""
import sys, os, json, time, uuid, sqlite3, threading, urllib.parse, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize"
TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token"
# client_P8X5 = client zcode desktop (auth-code flow). redirect localhost
# port 3000 + /oauth/callback/zai = whitelist (dari test server: OK)
APP_ID = "client_P8X5CMWmlaRO9gyO-KSqtg"
CALLBACK_PORT = 3000
CALLBACK_PATH = "/oauth/callback/zai"
REDIRECT_URI = f"http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}"
PLAN_ID = "zcode-v3-start-plan-0828"
APP_VERSION = "3.10.0"
PLATFORM = "win32-x64"
DEVICE_MID = str(uuid.uuid4())


def load_account(email=None):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    if email:
        row = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    else:
        row = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode' AND isActive=1 ORDER BY RANDOM() LIMIT 1").fetchone()
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


def req(method, url, body=None, auth=None, extra_headers=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if auth:
        h["Authorization"] = f"Bearer {auth}"
    if extra_headers:
        h.update(extra_headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"raw": e.read().decode()[:200]}


def z_login(access_token):
    st, j = req("POST", "https://api.z.ai/api/auth/z/login", {"token": access_token})
    if st != 200:
        return None, f"z/login failed {st}"
    return j.get("data", {}).get("access_token", ""), None


def get_api_key(biz_token):
    """customer info -> org/project -> api key + secret (short-circuit balik)"""
    st, info = req("GET", "https://api.z.ai/api/biz/customer/getCustomerInfo", auth=biz_token)
    if st != 200:
        return None, "customerInfo failed"
    orgs = (info.get("data") or {}).get("organizations") or []
    if not orgs:
        return None, "no org"
    org = orgs[0]
    org_id = org.get("organizationId")
    projs = org.get("projects") or []
    if not projs:
        return None, "no project"
    proj_id = projs[0]["projectId"]
    st, keys = req("GET", f"https://api.z.ai/api/biz/v1/organization/{org_id}/projects/{proj_id}/api_keys", auth=biz_token)
    if st != 200 or not keys.get("data"):
        return None, "no api keys"
    api_key = keys["data"][0]["apiKey"]
    st, sec = req("GET", f"https://api.z.ai/api/biz/v1/organization/{org_id}/projects/{proj_id}/api_keys/copy/{api_key}", auth=biz_token)
    secret = ""
    if st == 200:
        secret = (sec.get("data") or {}).get("secretKey") or ""
    return {"apiKey": api_key, "secretKey": secret}, None


def oauth_intercept_code(email, cookies, timeout_s=90):
    """Open authorize in Camoufox; provider redirect ke http://127.0.0.1:3000/oauth/callback/zai?code=...
    Callback server (start di main) menangkap code."""
    from camoufox.sync_api import Camoufox
    state = uuid.uuid4().hex
    auth_url = (f"{AUTHORIZE_URL}?client_id={APP_ID}&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
                f"&response_type=code&state={state}")

    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        inject_cookies(ctx, cookies)
        page = ctx.new_page()
        try:
            page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(8000)
            # tunggu redirect ke localhost callback (mungkin butuh klik "Authorize")
            # TUNGGU sampai URL berisi code (via navigation)
            start = time.time()
            while time.time() - start < timeout_s:
                u = page.url
                if "code=" in u or "authCode=" in u or "127.0.0.1" in u:
                    break
                page.wait_for_timeout(800)
            print("[oauth] akhir url:", page.url[:180])
            # kalau masih di halaman authorize, coba klik tombol authorize
            btns = page.evaluate("() => [...document.querySelectorAll('button,a')].map(b=>(b.innerText||'').trim()).filter(t=>t)")
            print("[oauth] buttons:", btns[:10])
            if any("authorize" in b.lower() or "continue" in b.lower() or "同意" in b for b in btns):
                page.click("text=" + next(b for b in btns if "authorize" in b.lower() or "continue" in b.lower() or "同意" in b))
                start = time.time()
                while time.time() - start < timeout_s:
                    u = page.url
                    if "code=" in u or "authCode=" in u or "127.0.0.1" in u:
                        break
                    page.wait_for_timeout(500)
            print("[oauth] final url:", page.url[:250])
            qu = urllib.parse.parse_qs(urllib.parse.urlparse(page.url).query)
            code = (qu.get("code") or qu.get("authCode") or [None])[0]
            return code, state
        except Exception as e:
            return None, f"oauth error: {str(e)[:120]}"


def exchange_code(code, state):
    st, j = req("POST", TOKEN_URL, {"provider": "zai", "code": code,
                                    "redirect_uri": REDIRECT_URI, "state": state})
    if st != 200:
        return None, f"exchange failed {st}: {json.dumps(j)[:200]}"
    jwt = (j.get("data") or {}).get("token") or ""
    return jwt, None


def claim_plan(jwt, plan_id=PLAN_ID):
    hdrs = {
        "User-Agent": "ZCode/3.10.0", "X-ZCode-App-Version": APP_VERSION,
        "X-Platform": PLATFORM, "X-Title": "Z Code@cli", "X-ZCode-Agent": "glm",
        "X-Release-Channel": "production", "X-Client-Language": "en-US",
        "X-Client-Timezone": "Asia/Shanghai", "X-Os-Category": "windows",
        "X-Os-Version": "10.0.22631", "X-Device-Mid": DEVICE_MID,
        "HTTP-Referer": "https://zcode.z.ai",
    }
    st, j = req("POST", "https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
                {"plan_id": plan_id}, auth=jwt, extra_headers=hdrs)
    return st, j


def process_account(email):
    acc = load_account(email)
    if not acc:
        return {"email": email, "ok": False, "error": "no account"}
    tokens = acc["token"]
    out = {"email": email}

    # 1) z/login
    biz, err = z_login(tokens)
    if err:
        out.update({"ok": False, "step": "z_login", "error": err})
        return out
    out["biz_len"] = len(biz)

    # 2) oauth intercept code
    code, oauth_state = oauth_intercept_code(email, acc["cookies"])
    if not code or isinstance(oauth_state, str):
        out.update({"ok": False, "step": "oauth", "error": oauth_state if isinstance(oauth_state, str) else "no code"})
        return out
    out["code"] = code[:20]

    # 3) exchange -> jwt
    jwt, err = exchange_code(code, oauth_state)
    if err:
        out.update({"ok": False, "step": "exchange", "error": err})
        return out
    out["jwt_len"] = len(jwt)

    # 4) claim
    st, j = claim_plan(jwt)
    out["claim_status"] = st
    out["claim_body"] = json.dumps(j)[:300]
    out["ok"] = st == 200 and j.get("code") == 0

    # save jwt to DB
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE email=?", (email,)).fetchone()
    if row:
        d = json.loads(row[0])
        psd = d.setdefault("providerSpecificData", {})
        psd["zcodeJwt"] = jwt
        psd["zcodeClaim"] = {"planId": PLAN_ID, "ok": out["ok"], "ts": time.time()}
        conn.execute("UPDATE providerConnections SET data=? WHERE email=?", (json.dumps(d), email))
        conn.commit()
    conn.close()
    return out


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        conn = sqlite3.connect(DB)
        rows = conn.execute("SELECT email FROM providerConnections WHERE provider='zcode' AND isActive=1").fetchall()
        conn.close()
        emails = [r[0] for r in rows]
        print(f"BULK: {len(emails)} accounts")
        results = []
        for i, email in enumerate(emails):
            print(f"[{i+1}/{len(emails)}] {email}", flush=True)
            r = process_account(email)
            print("  ->", json.dumps(r)[:200], flush=True)
            results.append(r)
            time.sleep(2)
        with open("/tmp/zcode_weekend_claim_results.json", "w") as f:
            json.dump(results, f, indent=1)
        print("DONE. Saved /tmp/zcode_weekend_claim_results.json")
        return
    email = sys.argv[1] if len(sys.argv) > 1 else None
    print(json.dumps(process_account(email), indent=1))


if __name__ == "__main__":
    main()