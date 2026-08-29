#!/usr/bin/env python3
"""Debug11: buka authorize, tunggu render, dump semua tombol/button + iframe + localStorage."""
import sys, os, json, time, uuid, sqlite3, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account, inject_cookies

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)

from camoufox.sync_api import Camoufox
state = uuid.uuid4().hex
callback_url = "http://127.0.0.1:3000/oauth/callback/zai"
auth_url = ("https://chat.z.ai/api/oauth/authorize?"
            f"redirect_uri={urllib.parse.quote(callback_url, safe='')}&response_type=code"
            "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=" + state)

with Camoufox(headless=True) as browser:
    ctx = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    n = inject_cookies(ctx, acc["cookies"])
    print("cookies:", n)
    page = ctx.new_page()
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    # tunggu render
    page.wait_for_timeout(12000)
    print("=== url ===", page.url[:180])
    print("=== title ===", page.title()[:80])
    # dump buttons
    btns = page.evaluate("""() => [...document.querySelectorAll('button, a, [role=button], input[type=submit]')]
        .map(b => ({tag: b.tagName, text: (b.innerText||b.value||'').trim().slice(0,60), id: b.id||'', cls: (b.className||'').slice(0,50)}))
        .filter(b => b.text || b.id)""")
    print("=== buttons/links ===")
    for b in btns[:20]: print("  ", json.dumps(b, ensure_ascii=False)[:150])
    # body text full
    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0, 1200) : ''")
    print("=== body ===")
    print(txt[:1200])
    # iframes
    ifr = page.evaluate("() => [...document.querySelectorAll('iframe')].map(f=>f.src.slice(0,120))")
    print("=== iframes ===", ifr)
    # localStorage token?
    ls = page.evaluate("""() => { try { const o={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=(localStorage.getItem(k)||'').slice(0,60);} return o; } catch(e){ return {err:e.message}; } }""")
    print("=== localStorage keys ===", list(ls.keys())[:20] if isinstance(ls, dict) else ls)