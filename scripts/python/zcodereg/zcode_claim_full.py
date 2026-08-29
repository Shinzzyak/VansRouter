#!/usr/bin/env python3
"""ZCode Weekend Claim — FULL pipeline (bulk-ready).

Per account:
  1. OAuth code via Camoufox (client_lS94 + z.ai/subscribe; tangkap code sebelum z.ai konsumsi)
  2. exchange code -> ZCode JWT (zcode.z.ai/api/v1/oauth/token)
  3. captcha solve via happy-dom solver (zcode-api repo, bun)
  4. claim plan (zcode.z.ai/api/v1/zcode-plan/billing/claim)

Usage:
  python3 zcode_claim_full.py <email>        # single
  python3 zcode_claim_full.py --all          # bulk (108)
"""
import sys, os, json, time, uuid, sqlite3, urllib.parse, urllib.request, urllib.error, subprocess, base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
PLAN_ID = "zcode-v3-start-plan-0828"
APP_VERSION = "3.10.0"
PLATFORM = "win32-x64"
SOLVER_DIR = "/tmp/zcode-api-repo"
BUN = os.path.expanduser("~/.bun/bin/bun")
SCENE = "11xygtvd"
REGION = "sgp"
PREFIX = "no8xfe"


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


def req(method, url, body=None, auth=None, extra=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if auth: h["Authorization"] = f"Bearer {auth}"
    if extra: h.update(extra)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="ignore")


def oauth_get_code(email, cookies, timeout_s=60):
    """Camoufox: authorize client_lS94 + z.ai/subscribe; tangkap code= via framenavigated
    (terbukti di debug4: navigation z.ai/subscribe?code=... & state=...)."""
    from camoufox.sync_api import Camoufox
    state = uuid.uuid4().hex
    captured = {}
    auth_url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_lS94_Ka2ycE9IwCNYisudg"
                f"&redirect_uri={urllib.parse.quote('https://z.ai/subscribe')}&response_type=code&state={state}")
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        inject_cookies(ctx, cookies)
        page = ctx.new_page()
        def _on_nav(frame):
            u = frame.url
            if "code=" in u:
                captured["url"] = u
        page.on("framenavigated", _on_nav)
        page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        start = time.time()
        while time.time() - start < timeout_s:
            if captured.get("url"):
                break
            page.wait_for_timeout(500)
        if not captured.get("url"):
            return None, state, "no code"
        u = captured["url"]
        qu = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        code = (qu.get("code") or [None])[0]
        return code, state, None


def exchange_code(code, state):
    st, j = req("POST", "https://zcode.z.ai/api/v1/oauth/token",
                {"provider": "zai", "code": code, "redirect_uri": "https://z.ai/subscribe", "state": state})
    try:
        d = json.loads(j)
        jwt = (d.get("data") or {}).get("token") or ""
    except Exception:
        jwt = ""
    return jwt, st, j


def solve_captcha(retries=5):
    """happy-dom solver via bun (zcode-api repo)."""
    for i in range(retries):
        try:
            r = subprocess.run([BUN, "run", "run-captcha.ts", SCENE, REGION, PREFIX],
                               cwd=SOLVER_DIR, capture_output=True, text=True, timeout=150)
            for line in r.stdout.splitlines():
                if line.startswith("VERIFY_PARAM:"):
                    return line[len("VERIFY_PARAM:"):].strip()
        except Exception:
            pass
        time.sleep(1)
    return None


def claim_plan(jwt, verify_param):
    hdrs = {
        "User-Agent": "ZCode/3.10.0", "X-ZCode-App-Version": APP_VERSION,
        "X-Platform": PLATFORM, "X-Title": "Z Code@cli", "X-ZCode-Agent": "glm",
        "X-Release-Channel": "production", "X-Client-Language": "en-US",
        "X-Client-Timezone": "Asia/Shanghai", "X-Os-Category": "windows",
        "X-Os-Version": "10.0.22631", "X-Device-Mid": str(uuid.uuid4()),
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Aliyun-Captcha-Verify-Param": verify_param,
        "X-Aliyun-Captcha-Verify-Region": REGION,
    }
    st, j = req("POST", "https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
                {"plan_id": PLAN_ID}, auth=jwt, extra=hdrs)
    return st, j


def process_account(email):
    acc = load_account(email)
    if not acc:
        return {"email": email, "ok": False, "error": "no account"}
    out = {"email": email}

    # 1) JWT fresh via OAuth
    code, state, err = oauth_get_code(email, acc["cookies"])
    if err:
        out.update({"ok": False, "step": "oauth", "error": err})
        return out
    out["code"] = code[:20]

    jwt, st, j = exchange_code(code, state)
    if not jwt:
        out.update({"ok": False, "step": "exchange", "status": st, "body": j[:200]})
        return out
    out["jwt_len"] = len(jwt)

    # 2) captcha
    vp = solve_captcha()
    if not vp:
        out.update({"ok": False, "step": "captcha", "error": "no token"})
        return out
    out["vp_len"] = len(vp)

    # 3) claim
    st, j = claim_plan(jwt, vp)
    out["claim_status"] = st
    out["claim_body"] = j[:300]
    try:
        cc = json.loads(j)
        out["ok"] = st == 200 and cc.get("code") == 0
        out["biz_code"] = cc.get("code")
    except Exception:
        out["ok"] = False

    # save jwt
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE email=?", (email,)).fetchone()
    if row:
        d = json.loads(row[0])
        psd = d.setdefault("providerSpecificData", {})
        psd["zcodeJwtToken"] = jwt
        psd["zcodeClaimTs"] = time.time()
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
            print("  ->", json.dumps(r)[:250], flush=True)
            results.append(r)
            time.sleep(3)
        with open("/tmp/zcode_weekend_claim_results.json", "w") as f:
            json.dump(results, f, indent=1)
        print("DONE. Saved /tmp/zcode_weekend_claim_results.json")
        return
    email = sys.argv[1] if len(sys.argv) > 1 else None
    print(json.dumps(process_account(email), indent=1))


if __name__ == "__main__":
    main()