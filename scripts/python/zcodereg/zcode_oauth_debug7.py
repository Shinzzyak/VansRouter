#!/usr/bin/env python3
"""Debug: buka authorize + dump URL final + DOM text (untuk lihat error 'not registered')."""
import sys, os, json, time, uuid, sqlite3, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)

from camoufox.sync_api import Camoufox
state = uuid.uuid4().hex
port = 3000
callback_url = f"http://127.0.0.1:{port}/oauth/callback/zai"
auth_url = ("https://chat.z.ai/api/oauth/authorize?"
            f"redirect_uri={urllib.parse.quote(callback_url, safe='')}"
            "&response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg"
            f"&state={state}")
print("auth_url:", auth_url[:160])

with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    n = inject_cookies(ctx, acc["cookies"])
    print("cookies:", n)
    page = ctx.new_page()
    navs = []
    def _nav(frame):
        navs.append(frame.url[:160])
        print("[nav]", frame.url[:160], flush=True)
    page.on("framenavigated", _nav)
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    print("=== final url ===", page.url[:200])
    print("=== title ===", page.title())
    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0, 800) : ''")
    print("=== body text ===")
    print(txt)
    print("=== navs ===")
    for kv in navs[:10]: print("  ", kv)