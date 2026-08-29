#!/usr/bin/env python3
"""Debug6: dump FULL DOM halaman authorize (client_P8X5 + localhost3k)."""
import sys, os, json, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_claim import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context()
    inject_cookies(ctx, acc["cookies"])
    page = ctx.new_page()
    url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg"
           "&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Foauth%2Fcallback%2Fzai"
           "&response_type=code&state=debug999")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(15000)
    print("url:", page.url[:260])
    print("title:", page.title())
    # Dump HTML luar
    html = page.evaluate("() => document.documentElement.outerHTML.slice(0, 3000)")
    print("html:", html[:2500])