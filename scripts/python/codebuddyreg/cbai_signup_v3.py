#!/usr/bin/env python3
"""
CodeBuddy INTL signup via Google OAuth — v3 Keycloak broker path (2026-08-30):
1. POST /v2/plugin/auth/state?platform=CLI → state + authUrl
2. GET authUrl → iframe Keycloak OIDC (client_id=console) → html berisi broker link
   /auth/realms/copilot/broker/google/login?client_id=console&tab_id=...&client_data=...&session_code=...
3. Buka broker link (browser, cookies google injected) → Google OAuth → consent → redirect
4. Poll /v2/plugin/auth/token?state= → token
"""
import json, sys, time, re, urllib.request, urllib.parse

EMAIL = sys.argv[1] if len(sys.argv) > 1 else "sarah.johnson@e-mail.bty.web.id"
BASE = "https://www.codebuddy.ai"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"

def post_json(url, payload, headers):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

H = {"Content-Type": "application/json", "X-Domain": "www.codebuddy.ai",
     "User-Agent": "VSCode/1.119.0 CodeBuddy/4.9.29177644", "X-Product": "SaaS"}
st = post_json(f"{BASE}/v2/plugin/auth/state?platform=CLI", {}, H)
state = st["data"]["state"]
auth_url = st["data"]["authUrl"]
print(f"state: {state}")

# ---------- cookies dari DB ----------
import sqlite3
DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
conn = sqlite3.connect(DB)
row = conn.execute("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?", (EMAIL,)).fetchone()
conn.close()
if not row:
    print("no cookies for", EMAIL)
    sys.exit(1)
cookies = (json.loads(row[0]).get("providerSpecificData") or {}).get("cookies", [])
print(f"cookies: {len(cookies)}")

from camoufox.sync_api import Camoufox

broker_holder = {}
POLL_TOKEN = f"{BASE}/v2/plugin/auth/token?state={state}"

with Camoufox(headless=False, geoip=True, proxy={"server": "socks5://127.0.0.1:40000"}) as browser:
    ctx = browser.new_context()
    inj = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom:
            continue
        ck = {"name": c["name"], "value": c["value"]}
        if dom in ("accounts.google.com", "google.com"):
            ck["url"] = "https://" + dom
        else:
            ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
            ck["path"] = "/"
        try:
            ctx.add_cookies([ck])
            inj += 1
        except Exception:
            pass
    print(f"cookies injected: {inj}")

    page = ctx.new_page()

    # Step A: buka login page → iframe keycloak → extract broker google link
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    time.sleep(10)
    broker_link = None
    for f in page.frames:
        try:
            el = f.query_selector("#social-google")
            if el:
                href = el.get_attribute("href")
                if href:
                    broker_link = urllib.parse.urljoin(f.url, href)
                    print(f"broker link: {broker_link[:100]}...")
                    break
        except Exception:
            pass
    if not broker_link:
        # fallback: parse html dari keycloak frame via evaluate
        for f in page.frames:
            try:
                html = f.content()
                m = re.search(r'id="social-google"[^>]*href="([^"]+)"', html)
                if m:
                    broker_link = urllib.parse.urljoin(f.url, m.group(1).replace("&amp;", "&"))
                    print(f"broker link (regex): {broker_link[:100]}...")
                    break
            except Exception:
                pass
    if not broker_link:
        page.screenshot(path="/tmp/cbai_v3_no_broker.png")
        print("FAILED: no broker link found")
        sys.exit(1)

    # Step B: buka broker link di page yang sama (full navigation, bukan popup)
    page.goto(broker_link, wait_until="domcontentloaded", timeout=60000)
    time.sleep(6)
    print("URL after broker:", page.url[:110])

    # Step C: Google OAuth flow (loop sampai balik ke codebuddy)
    for attempt in range(8):
        cur = page.url
        if "codebuddy.ai" in cur and "accounts.google" not in cur and "login-actions" not in cur:
            print(f"[{attempt}] back on codebuddy: {cur[:90]}")
            break
        # google account chooser / identifier
        filled = False
        for f in page.frames:
            try:
                em = f.query_selector("input[type=email]")
                if em and em.is_visible():
                    em.fill(EMAIL)
                    time.sleep(1)
                    nxt = f.query_selector("#identifierNext")
                    if nxt:
                        nxt.click()
                        print("email filled + next")
                    time.sleep(4)
                    filled = True
                    break
            except Exception:
                pass
        if filled:
            page.screenshot(path=f"/tmp/cbai_v3_{attempt}.png")
            continue
        # consent / account chooser
        clicked = False
        for f in page.frames:
            try:
                for sel in ["#submit_approve_access", "button:has-text('Allow')",
                            "button:has-text('Lanjutkan')", "button:has-text('Continue')",
                            "div[data-identifier]", "[data-email]"]:
                    el = f.query_selector(sel)
                    if el and el.is_visible():
                        el.click()
                        print(f"[{attempt}] clicked: {sel}")
                        clicked = True
                        time.sleep(5)
                        break
                if clicked:
                    break
            except Exception:
                pass
        page.screenshot(path=f"/tmp/cbai_v3_{attempt}.png")
        if not filled and not clicked:
            print(f"[{attempt}] no action — URL: {cur[:90]}")
        time.sleep(4)

    page.screenshot(path="/tmp/cbai_v3_final.png")
    print("final URL:", page.url[:110])

# ---------- poll token ----------
print("polling token...")
tok = None
for i in range(60):
    try:
        req = urllib.request.Request(POLL_TOKEN, headers={"X-Domain": "www.codebuddy.ai"})
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read().decode())
        code = d.get("code")
        if code == 0 and d.get("data", {}).get("accessToken"):
            tok = d["data"]
            print(f"TOKEN OK after {i}s")
            break
        if i % 10 == 0:
            print(f"  poll {i}: code={code}")
    except Exception as e:
        print(f"  poll {i} err: {str(e)[:60]}")
    time.sleep(1)

if tok:
    out = {"email": EMAIL, "state": state, "accessToken": tok.get("accessToken"),
           "refreshToken": tok.get("refreshToken"), "expiresAt": tok.get("expiresAt"),
           "refreshExpiresAt": tok.get("refreshExpiresAt"), "domain": "www.codebuddy.ai",
           "account": tok.get("account", {})}
    fn = f"/tmp/cbai_token_{EMAIL.replace('@','_at_')}.json"
    json.dump(out, open(fn, "w"), indent=2)
    print(f"SAVED: {fn}")
    print("uid:", (tok.get('account') or {}).get('uid', '?')[:12])
else:
    print("FAILED: no token after 60s")
    sys.exit(1)
