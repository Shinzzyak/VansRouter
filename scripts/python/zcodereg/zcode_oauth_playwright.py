#!/usr/bin/env python3
"""OAuth via Playwright Chromium ASLI (bukan Camoufox) + cookies sarah.
Server menolak Camoufox signature; Chromium asli = flow production desktop."""
import sys, os, json, time, uuid, sqlite3, urllib.parse, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"


def load_account(email):
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    conn.close()
    d = json.loads(row[0])
    psd = d.get("providerSpecificData") or {}
    return {"email": email, "cookies": psd.get("cookies", [])}


def inject_cookies(ctx, cookies):
    n = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom:
            continue
        ck = {"name": c["name"], "value": c["value"]}
        if dom in ("chat.z.ai", "zcode.z.ai", "z.ai", "accounts.google.com", "google.com"):
            ck["url"] = "https://" + dom
        else:
            ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
            ck["path"] = "/"
        try:
            ctx.add_cookies([ck]); n += 1
        except Exception:
            pass
    return n


_cb = {}
_cb_state = uuid.uuid4().hex


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        st = (q.get("state") or [""])[0]
        code = (q.get("authCode") or q.get("code") or [""])[0]
        print(f"[CB] path={u.path} state_ok={st == _cb_state} code={code[:25]}", flush=True)
        _cb.update({"code": code, "state": st})
        self.send_response(200); self.end_headers()
        self.wfile.write(b"OK")


def main():
    email = sys.argv[1] if len(sys.argv) > 1 else "sarah.johnson@e-mail.bty.web.id"
    acc = load_account(email)
    print("email:", email, "| cookies:", len(acc["cookies"]))

    srv = HTTPServer(("127.0.0.1", 38549), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    callback_url = "http://127.0.0.1:38549/oauth/callback/zai"
    auth_url = ("https://chat.z.ai/api/oauth/authorize?"
                f"redirect_uri={urllib.parse.quote(callback_url, safe='')}&response_type=code"
                "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=" + _cb_state)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path="/home/ubuntu/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
        )
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        n = inject_cookies(ctx, acc["cookies"])
        print("cookies injected:", n)
        page = ctx.new_page()
        page.on("framenavigated", lambda f: print("[nav]", f.url[:150], flush=True) if ("callback" in f.url or "code=" in f.url or "/auth" in f.url) else None)
        page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        print("url after load:", page.url[:150])
        # klik google
        try:
            r = page.evaluate("""() => {
                const btns=[...document.querySelectorAll('button')];
                const b=btns.find(x=>(x.innerText||'').includes('Google'));
                if(b){b.click();return true;}
                return false;
            }""")
            print("clicked google:", r)
        except Exception as e:
            print("click err:", str(e)[:100])
        # tunggu redirect
        start = time.time()
        while time.time() - start < 90:
            if _cb.get("code"):
                break
            try:
                u = page.url
                if "127.0.0.1" in u or "callback" in u or "code=" in u:
                    break
            except Exception:
                pass
            page.wait_for_timeout(1000)
        print("final url:", page.url[:200])
        txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,300) : ''")
        print("body:", txt[:300])
        browser.close()
    srv.shutdown()
    print("CB:", _cb)


if __name__ == "__main__":
    main()