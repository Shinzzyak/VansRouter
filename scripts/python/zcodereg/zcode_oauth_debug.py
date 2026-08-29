#!/usr/bin/env python3
"""Debug: buka halaman authorize chat.z.ai dengan cookies akun, screenshot + DOM."""
import sys, os, json, sqlite3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_claim import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)
print("email:", acc["email"], "| token len:", len(acc["token"]), "| cookies:", len(acc["cookies"]))

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    n = inject_cookies(ctx, acc["cookies"])
    print("injected:", n)
    page = ctx.new_page()
    auth_url = "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=http%3A%2F%2F127.0.0.1%3A38159%2Fcallback&response_type=code&state=test123"
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(10000)
    print("final url:", page.url[:200])
    print("title:", page.title())
    # dump body text
    body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 2000) : '(no body)'")
    print("body:", body[:1500])
    # cek tombol/button
    buttons = page.evaluate("() => [...document.querySelectorAll('button,a')].map(b => (b.innerText||'').trim()).filter(t=>t).slice(0,20)")
    print("buttons:", buttons)
    page.screenshot(path="/tmp/zcode_oauth_debug.png", full_page=False)
    print("screenshot: /tmp/zcode_oauth_debug.png")