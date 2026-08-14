"""kimchi_gmail_login.py — Google OAuth login ke kimchi (pakai akun GSuite farm).

Flow:
1. Buka app.kimchi.dev → Sign in → Google (WARP, CF pass)
2. Google login (email+password GSuite dari gsuite-accounts.txt) — reuse _fill_google_login
3. Consent → redirect balik app.kimchi.dev → session active
4. Buka /settings → buat API key → simpan castai_v1_* ke DB VansRouter

Resource: 110 akun @e-mail.bty.web.id (GSuite workspace, email verified).
"""
import sys, time, json, re, argparse
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
sys.path.insert(0, "/home/ubuntu/x-farm")
from camoufox import Camoufox

WARP = "http://127.0.0.1:40000"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("password")
    ap.add_argument("--headless", action="store_true", default=True)
    args = ap.parse_args()

    with Camoufox(headless=args.headless, proxy={"server": WARP}, geoip=True) as browser:
        page = browser.new_page()
        # 1. app.kimchi.dev — tunggu CF + SPA
        page.goto("https://app.kimchi.dev", wait_until="domcontentloaded", timeout=60000)
        for i in range(45):
            page.wait_for_timeout(2000)
            t = page.title()
            if "Just a moment" not in t and "Hanya sebentar" not in t and "请稍候" not in t:
                break
        # tunggu tombol login
        for i in range(20):
            page.wait_for_timeout(3000)
            body = page.evaluate("document.body ? document.body.innerText.slice(0,300) : ''")
            if "Sign in" in body or "Google" in body:
                break
        print("TITLE:", page.title())
        print("URL:", page.url[:120])
        # 2. klik Sign in → Google
        for sel in ["button:has-text('Sign in')", "a:has-text('Sign in')"]:
            try:
                if page.locator(sel).count() and page.locator(sel).first.is_visible(timeout=3000):
                    page.locator(sel).first.click()
                    print("CLICKED sign in")
                    break
            except Exception:
                pass
        page.wait_for_timeout(4000)
        for sel in ["button:has-text('Google')", "a:has-text('Google')", "button:has-text('Continue with Google')"]:
            try:
                if page.locator(sel).count() and page.locator(sel).first.is_visible(timeout=3000):
                    page.locator(sel).first.click()
                    print("CLICKED Google")
                    break
            except Exception:
                pass
        # 3. tunggu redirect ke Google
        for i in range(15):
            page.wait_for_timeout(2000)
            if "accounts.google.com" in page.url:
                break
        print("GOOGLE URL:", page.url[:100])
        # 4. Google login — reuse _fill_google_login
        try:
            from google_login import _fill_google_login
            _fill_google_login(page, args.email, args.password)
            print("GOOGLE LOGIN OK")
        except Exception as e:
            print("google fill err:", e)
        # 5. tunggu redirect balik kimchi
        for i in range(20):
            page.wait_for_timeout(3000)
            u = page.url
            if "app.kimchi.dev" in u and "google" not in u:
                break
        print("FINAL URL:", page.url[:150])
        # 6. consent kimchi? klik Allow/Continue
        for i in range(5):
            body = page.evaluate("document.body ? document.body.innerText.slice(0,300) : ''")
            for txt in ["Allow", "Continue", "Authorize", "Accept"]:
                try:
                    b = page.get_by_role("button", name=re.compile(txt, re.I))
                    if b.count():
                        b.first.click(timeout=2000)
                        print("CLICKED consent:", txt)
                        page.wait_for_timeout(3000)
                except Exception:
                    pass
        # 7. buka settings → buat API key
        page.goto("https://app.kimchi.dev/settings", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)
        body = page.evaluate("document.body ? document.body.innerText.slice(0,600) : ''")
        print("SETTINGS BODY:", body.replace("\n", " | ")[:400])
        btns = page.evaluate("""() => [...document.querySelectorAll('button,a')].map(b => (b.innerText||'').trim().slice(0,40)).filter(t => t).slice(0,25)""")
        print("BUTTONS:", btns)
        page.screenshot(path="/tmp/kimchi_gsuite.png")
        # dump localStorage tokens
        ls = page.evaluate("""() => { const o = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(/token|auth|key|jwt/i.test(k)) o[k]=localStorage.getItem(k).slice(0,60);} return o; }""")
        print("LS:", json.dumps(ls)[:300])
        # cek cookies
        cookies = page.context.cookies()
        for c in cookies:
            if any(x in c["name"].lower() for x in ["token", "auth", "session", "key"]):
                print("COOKIE:", c["name"], "=", c["value"][:50])
    print("done")

if __name__ == "__main__":
    main()
