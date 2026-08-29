#!/usr/bin/env python3
"""Debug3: authorize dengan client_lS94_Ka2ycE9IwCNYisudg + z.ai/subscribe, cookies akun."""
import sys, os, json, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_claim import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)
print("email:", acc["email"], "| cookies:", len(acc["cookies"]))

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    n = inject_cookies(ctx, acc["cookies"])
    print("injected:", n)
    page = ctx.new_page()
    url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_lS94_Ka2ycE9IwCNYisudg"
           "&redirect_uri=https%3A%2F%2Fz.ai%2Fsubscribe&response_type=code&state=debug456")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(12000)
    print("url:", page.url[:300])
    print("title:", page.title())
    body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 2000) : '(none)'")
    print("body:", body[:1800])
    btns = page.evaluate("() => [...document.querySelectorAll('button,a')].map(b=>(b.innerText||'').trim()).filter(t=>t).slice(0,25)")
    print("buttons:", btns)
    page.screenshot(path="/tmp/zcode_oauth_debug3.png")
    print("shot: /tmp/zcode_oauth_debug3.png")