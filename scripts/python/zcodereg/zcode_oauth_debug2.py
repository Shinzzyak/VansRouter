#!/usr/bin/env python3
"""Debug2: buka authorize + dump halaman (Camoufox)."""
import sys, os, json, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_claim import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)
print("cookies:", len(acc["cookies"]))

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    n = inject_cookies(ctx, acc["cookies"])
    print("injected:", n)
    page = ctx.new_page()
    url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg"
           "&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Foauth%2Fcallback%2Fzai"
           "&response_type=code&state=debug123")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(12000)
    print("url:", page.url[:300])
    print("title:", page.title())
    body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 1500) : '(none)'")
    print("body:", body[:1300])
    btns = page.evaluate("() => [...document.querySelectorAll('button,a')].map(b=>(b.innerText||'').trim()).filter(t=>t).slice(0,25)")
    print("buttons:", btns)
    page.screenshot(path="/tmp/zcode_oauth_debug2.png")
    print("shot: /tmp/zcode_oauth_debug2.png")