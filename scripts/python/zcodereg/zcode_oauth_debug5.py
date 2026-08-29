#!/usr/bin/env python3
"""Debug5: intercept auth code via JS injection pada halaman authorize.
Z.ai OAuth internal: https://chat.z.ai/api/oauth/authorize — setelah authorize,
server SET COOKIE code / atau JS fetch /generateAuthCode. Kita inject before
fetch untuk menangkap response yang berisi code.
"""
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
    captured = []
    page.add_init_script("""
        window.__codes = [];
        const _origFetch = window.fetch;
        window.fetch = async function(...args) {
            const resp = await _origFetch.apply(this, args);
            try {
                const url = String(args[0] || '');
                const clone = resp.clone();
                const text = await clone.text();
                if (/code|auth/i.test(url) || /code|auth/i.test(text)) {
                    window.__codes.push({url: url, body: text.slice(0, 500)});
                }
            } catch(e) {}
            return resp;
        };
        const _origXHR = XMLHttpRequest.prototype.open;
        const _origSend = XMLHttpRequest.prototype.send;
        const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this.__url = url;
            return _origXHR.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            this.addEventListener('load', function() {
                try {
                    const t = this.responseText || '';
                    if (/code|auth/i.test(this.__url || '') || /code|auth/i.test(t)) {
                        window.__codes.push({url: this.__url, body: t.slice(0, 400)});
                    }
                } catch(e) {}
            });
            return _origSend.apply(this, args);
        };
    """)
    url = ("https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg"
           "&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Foauth%2Fcallback%2Fzai"
           "&response_type=code&state=debug999")
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(12000)
    print("url akhir:", page.url[:250])
    codes = page.evaluate("() => window.__codes || []")
    print("captured:", json.dumps(codes, indent=1)[:2000])