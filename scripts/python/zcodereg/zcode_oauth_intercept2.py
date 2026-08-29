#!/usr/bin/env python3
"""Test: capture code via framenavigated + ABORT z.ai/login/callback supaya code tidak dikonsumsi,
lalu exchange ke zcode.z.ai (provider zai)."""
import sys, os, json, time, uuid, sqlite3, urllib.parse, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_claim_full import load_account, inject_cookies, exchange_code, req

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)
print("email:", acc["email"], "| cookies:", len(acc["cookies"]))

from camoufox.sync_api import Camoufox
state = uuid.uuid4().hex
captured = {}
auth_url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_lS94_Ka2ycE9IwCNYisudg"
            f"&redirect_uri={urllib.parse.quote('https://z.ai/subscribe')}&response_type=code&state={state}")

with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    n = inject_cookies(ctx, acc["cookies"])
    print("injected:", n)
    page = ctx.new_page()
    def _route(route):
        u = route.request.url
        if "login/callback" in u or "/subscribe?code=" in u:
            print("INTERCEPT:", u[:120])
            # jangan abort subscribe?code (kita perlu lihat), tapi abort login/callback
            if "login/callback" in u:
                captured["login_url"] = u
                route.abort()
                return
        if "code=" in u:
            captured["url"] = u
        route.continue_()
    def _on_nav(frame):
        u = frame.url
        if "code=" in u:
            captured["url"] = u
        if "login/callback" in u:
            captured["login_url"] = u
    page.on("framenavigated", _on_nav)
    try:
        page.route("**/*", _route)
    except Exception as e:
        print("route err:", e)
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    start = time.time()
    while time.time() - start < 60:
        if captured.get("url") and "login/callback" not in (captured.get("url") or ""):
            break
        page.wait_for_timeout(500)
    print("captured:", json.dumps({k: v[:130] for k, v in captured.items()}))
    u = captured.get("url") or captured.get("login_url") or ""
    qu = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
    code = (qu.get("code") or [None])[0]
    print("CODE:", code)
    if code:
        # exchange segment
        jwt, st, body = exchange_code(code, state)
        print("EXCHANGE:", st, "|", body[:300])
        if jwt:
            print("JWT LEN:", len(jwt), "| prefix:", jwt[:25])