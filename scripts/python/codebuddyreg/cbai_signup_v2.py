#!/usr/bin/env python3
"""
CodeBuddy INTL signup via Google OAuth — jalur yang BENAR (ditemukan 2026-08-30):
1. POST /v2/plugin/auth/state?platform=CLI (X-Domain: www.codebuddy.ai) → state + authUrl
2. Camoufox headful (xvfb) + WARP → buka authUrl → halaman Sign up RENDER PENUH
3. Centang consent checkbox → klik "Sign up with Google"
4. Google OAuth pakai cookies Gsuit (e-mail.bty.web.id) → consent → redirect balik
5. Poll GET /v2/plugin/auth/token?state= → accessToken + refreshToken
"""
import json, sys, time, urllib.request

EMAIL = sys.argv[1] if len(sys.argv) > 1 else "sarah.johnson@e-mail.bty.web.id"
BASE = "https://www.codebuddy.ai"

# ---------- 1. state ----------
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
print(f"authUrl: {auth_url}")

# ---------- 2-4. browser ----------
from camoufox.sync_api import Camoufox

# load cookies dari DB providerConnections (provider=zcode, cookies di providerSpecificData)
import sqlite3
DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
def load_cookies(email):
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    conn.close()
    if not row:
        return []
    d = json.loads(row[0])
    return (d.get("providerSpecificData") or {}).get("cookies", [])

cookies = load_cookies(EMAIL)

POLL_TOKEN = f"{BASE}/v2/plugin/auth/token?state={state}"

with Camoufox(headless=False, geoip=True, proxy={"server": "socks5://127.0.0.1:40000"}) as browser:
    ctx = browser.new_context()
    page = None
    # inject cookies (pola zcode proven: url untuk google domains)
    injected = 0
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
            injected += 1
        except Exception:
            pass
    print(f"cookies injected: {injected}/{len(cookies)}")

    page = ctx.new_page()
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    time.sleep(8)

    # screenshot awal
    page.screenshot(path="/tmp/cbai_step1.png")

    # centang consent checkbox (div custom, bukan input checkbox asli)
    clicked_cb = False
    for f in page.frames:
        try:
            el = f.query_selector("div[class*=checkbox]:not([class*=checked]), span[class*=checkbox]:not([class*=checked]), label[class*=checkbox]")
            if el:
                el.click()
                clicked_cb = True
                print("consent checkbox clicked (custom)")
                break
        except Exception:
            pass
    if not clicked_cb:
        # fallback: pakai vision-verified koordinat (viewport 1280x650 scale 1x)
        page.mouse.click(184, 477)
        print("consent checkbox clicked (coords 184,477)")
    time.sleep(1.5)

    # popup handler: OAuth Google biasanya buka popup
    popup_holder = {}
    def on_popup(p):
        popup_holder["page"] = p
        print(f"POPUP OPENED: {p.url[:80]}")
    ctx.on("page", on_popup)

    # klik Sign up with Google — selector-based (label EN atau 中文)
    google_clicked = False
    for f in page.frames:
        try:
            for sel in ["button:has-text('Sign up with Google')", "a:has-text('Sign up with Google')",
                        "button:has-text('使用 Google 注册')", "[class*=google]",
                        "button:has-text('Google')"]:
                el = f.query_selector(sel)
                if el and el.is_visible():
                    el.click()
                    google_clicked = True
                    print(f"Google button clicked via: {sel}")
                    break
            if google_clicked:
                break
        except Exception:
            pass
    if not google_clicked:
        # fallback: click_at koordinat — cari button Google via JS bounding box
        try:
            bb = page.evaluate("""() => {
                const btns = [...document.querySelectorAll('button, a, [role=button]')];
                const g = btns.find(b => /Google/i.test(b.innerText || ''));
                if (g) { const r = g.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }
                return null;
            }""")
            if bb:
                page.mouse.click(bb["x"], bb["y"])
                google_clicked = True
                print(f"Google button clicked via JS bbox ({bb['x']:.0f},{bb['y']:.0f})")
        except Exception:
            pass
    if not google_clicked:
        print("WARN: Google button not found — no click")
    time.sleep(6)

    page.screenshot(path="/tmp/cbai_step2_google.png")
    print("URL after google click:", page.url[:120])
    if "page" in popup_holder:
        page = popup_holder["page"]
        print("switched to popup page")

    # ---------- Google OAuth flow ----------
    for attempt in range(6):
        cur = page.url
        if "codebuddy.ai" in cur and "accounts.google" not in cur:
            print("back on codebuddy:", cur[:100])
            break
        # di halaman google accounts — isi email
        filled = False
        for f in page.frames:
            try:
                em = f.query_selector("input[type=email]")
                if em and em.is_visible():
                    em.fill(EMAIL)
                    filled = True
                    print("email filled")
                    time.sleep(1)
                    nxt = f.query_selector("#identifierNext, button:has-text('Next'), button:has-text('Lanjut')")
                    if nxt:
                        nxt.click()
                        print("next clicked")
                    time.sleep(4)
                    break
            except Exception:
                pass
        if filled:
            page.screenshot(path=f"/tmp/cbai_step3_{attempt}.png")
            continue
        # consent screen — klik Allow/Continue
        clicked_consent = False
        for f in page.frames:
            try:
                for sel in ["button:has-text('Allow')", "button:has-text('Izinkan')",
                            "button:has-text('Continue')", "button:has-text('Lanjutkan')",
                            "#submit_approve_access"]:
                    el = f.query_selector(sel)
                    if el and el.is_visible():
                        el.click()
                        print(f"consent clicked: {sel}")
                        clicked_consent = True
                        time.sleep(5)
                        break
                if clicked_consent:
                    break
            except Exception:
                pass
        if not filled and not clicked_consent:
            # akun google sudah login via cookies — mungkin langsung pilih akun (account chooser)
            for f in page.frames:
                try:
                    acc = f.query_selector("div[data-email*='e-mail.bty.web.id'], [data-identifier*='e-mail.bty.web.id'], div[class*=account]")
                    if acc and acc.is_visible():
                        acc.click()
                        print("account chooser clicked")
                        time.sleep(4)
                        break
                except Exception:
                    pass
        time.sleep(4)

    page.screenshot(path="/tmp/cbai_step4_final.png")
    print("final URL:", page.url[:120])

# ---------- 5. poll token ----------
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
