#!/usr/bin/env python3
"""Debug4: captur semua navigasi (request/response) OAuth + page URL terakhir."""
import sys, os, json, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_claim import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)
print("cookies:", len(acc["cookies"]))

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    inject_cookies(ctx, acc["cookies"])
    page = ctx.new_page()
    redirects = []
    page.on("framenavigated", lambda f: redirects.append(f.url))
    url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_lS94_Ka2ycE9IwCNYisudg"
           "&redirect_uri=https%3A%2F%2Fz.ai%2Fsubscribe&response_type=code&state=debug789")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(15000)
    print("url akhir:", page.url[:300])
    print("navigations:", redirects)
    # body z.ai/subscribe
    body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 500) : '(none)'")
    print("body:", body[:400])
    # cek localStorage (code kadang di lakukan)
    ls = page.evaluate("() => { try { return JSON.stringify(localStorage) } catch { return '(no ls)' } }")
    print("localStorage:", ls[:300])