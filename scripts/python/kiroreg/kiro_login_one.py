"""Kiro batch login: GSuite akun → cookies + ARN. Test 1 akun."""
import sys, time, json
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from camoufox import Camoufox

EMAIL = sys.argv[1] if len(sys.argv) > 1 else "sarah.johnson@e-mail.bty.web.id"
PASS = sys.argv[2] if len(sys.argv) > 2 else "StPQpSOY0wVR"
OUT = sys.argv[3] if len(sys.argv) > 3 else f"/tmp/kiro_{EMAIL.split('@')[0]}.txt"

with Camoufox(headless=False) as browser:
    page = browser.new_page()
    arn = None
    def on_resp(r):
        global arn
        u = r.url
        if "KiroWebPortalService/operation/GetUserInfo" in u:
            try:
                raw = r.body()
                txt = raw.decode("utf-8", errors="replace")
                import re
                m = re.search(r"profileArnx([^\x00-\x1f]{10,120})", txt)
                if m:
                    arn = m.group(1).rstrip("\x00")
            except Exception:
                pass
    page.on("response", on_resp)
    page.goto("https://app.kiro.dev/signin", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)
    btns = page.query_selector_all("button")
    for b in btns:
        t = (b.inner_text() or "").strip()
        if t.startswith("Google"):
            b.click()
            break
    page.wait_for_timeout(6000)
    try:
        page.wait_for_selector("#identifierId", timeout=20000)
        page.fill("#identifierId", EMAIL)
        page.press("#identifierId", "Enter")
        print("email ok", flush=True)
    except Exception as e:
        print("email ERR:", str(e)[:80], flush=True)
    page.wait_for_timeout(5000)
    try:
        page.wait_for_selector("input[type=password]", timeout=15000)
        page.fill("input[type=password]", PASS)
        page.press("input[type=password]", "Enter")
        print("pass ok", flush=True)
    except Exception as e:
        print("pass ERR:", str(e)[:80], flush=True)
    page.wait_for_timeout(8000)
    # Google Workspace TOS speedbump — klik Accept jika muncul
    for attempt in range(5):
        try:
            if "speedbump" in page.url or "workspacetermsofservice" in page.url:
                print("speedbump detected", flush=True)
                # dump semua button + link utk debug
                elems = page.evaluate("""() => Array.from(document.querySelectorAll('button, a, [role=button]')).map(e => (e.innerText || '').trim().slice(0, 40)).filter(t => t.length > 1).join(' | ')""")
                print("ELEMS:", elems[:300], flush=True)
                # coba semua selector umum
                for sel in ["button:has-text('Accept')", "button:has-text('Agree')", "button:has-text('Terima')", "button:has-text('Setuju')", "button:has-text('Continue')", "button:has-text('Lanjutkan')", "button:has-text('I understand')", "button:has-text('Saya mengerti')", "form button", "input[type=submit]"]:
                    btn = page.query_selector(sel)
                    if btn:
                        btn.click()
                        print("clicked", sel, flush=True)
                        break
                page.wait_for_timeout(3500)
        except Exception as e:
            print("sb err", str(e)[:60], flush=True)
        if "speedbump" not in page.url:
            print("speedbump passed", flush=True)
            break
        page.wait_for_timeout(2000)
    for sel in ["button[type=submit]", "button:has-text('Lanjutkan')", "button:has-text('Continue')"]:
        try:
            btn = page.wait_for_selector(sel, timeout=6000)
            if btn:
                btn.click()
                print("consent ok", flush=True)
                break
        except Exception:
            continue
    page.wait_for_timeout(8000)
    print("URL:", page.url[:90], flush=True)
    ck = page.context.cookies()
    kiro_c = [c for c in ck if "kiro" in c["domain"]]
    print("kiro cookies:", len(kiro_c), flush=True)
    with open(OUT, "w") as f:
        for c in ck:
            if "kiro" in c["domain"] or "cognito" in c["domain"]:
                f.write(f"{c['name']}\t{c['domain']}\t{c['value']}\n")
    print("saved", OUT, "| ARN:", arn or "NONE", flush=True)
