#!/usr/bin/env python3
"""Buka authorize URL di Camoufox (cookies akun) → code redirect ke repo localhost (port 38549)."""
import sys, os, json, time, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
auth_url = sys.argv[2] if len(sys.argv) > 2 else None
if not auth_url:
    print("Usage: zcode_oauth_browser.py <email> <auth_url>")
    sys.exit(1)

acc = load_account(email)
from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    inject_cookies(ctx, acc["cookies"])
    page = ctx.new_page()
    navs = []
    def _nav(frame):
        u = frame.url
        navs.append(u[:200])
        print("[nav]", u[:160], flush=True)
    page.on("framenavigated", _nav)
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    start = time.time()
    while time.time() - start < 70:
        try:
            u = page.url
            if "127.0.0.1" in u or "callback" in u:
                print("[FINAL]", u[:200], flush=True)
                break
        except Exception:
            pass
        # cek body
        try:
            txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,200) : ''")
            if "not registered" in (txt or "").lower():
                print("[ERROR] not registered:", txt[:200], flush=True)
            if "code=" in page.url:
                break
        except Exception:
            pass
        page.wait_for_timeout(1000)
    print("=== final ===")
    print("url:", page.url[:200])
    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,300) : ''")
    print("body:", txt)