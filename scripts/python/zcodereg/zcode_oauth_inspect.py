#!/usr/bin/env python3
"""Inspect halaman /auth — tombol login + click mereka."""
import sys, os, json, time, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
auth_url = sys.argv[2] if len(sys.argv) > 2 else None
acc = load_account(email)

from camoufox.sync_api import Camoufox
with Camoufox(headless=True) as browser:
    ctx = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    inject_cookies(ctx, acc["cookies"])
    page = ctx.new_page()
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    print("url:", page.url[:160])
    print("title:", page.title()[:60])
    # klik "Continue with Google" — cookies Google akun sudah ada
    clicked = False
    try:
        btn = page.evaluate("""() => {
            const btns = [...document.querySelectorAll('button')];
            const b = btns.find(x => (x.innerText||'').includes('Google'));
            if (b) { b.click(); return true; }
            return false;
        }""")
        print("clicked Google:", btn)
        clicked = btn
    except Exception as e:
        print("click err:", e)
    # tunggu OAuth flow
    start = time.time()
    while time.time() - start < 60:
        try:
            if "127.0.0.1" in page.url or "callback" in page.url or "code=" in page.url:
                print("[REDIRECT]", page.url[:200], flush=True)
                break
        except Exception:
            pass
        page.wait_for_timeout(1000)
    print("=== final url ===", page.url[:200])
    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,300) : ''")
    print("body:", txt[:300])