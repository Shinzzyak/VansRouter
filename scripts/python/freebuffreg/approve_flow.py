import asyncio, json, sys, re
from camoufox.sync_api import Camoufox

AUTH_CODE = sys.argv[1]
EMAIL = sys.argv[2]
PASSW = sys.argv[3]
WARP = "http://127.0.0.1:40000"
# Terima loginUrl utuh ATAU auth_code saja
if AUTH_CODE.startswith("http"):
    LOGIN_URL = AUTH_CODE
else:
    LOGIN_URL = f"https://freebuff.com/login?auth_code={AUTH_CODE}"

events = []

def on_request(req):
    u = req.url
    if any(k in u for k in ("accounts.google", "freebuff.com/api", "cli", "oauth")):
        events.append({"t": "req", "m": req.method, "u": u[:400]})

def on_response(resp):
    u = resp.url
    if any(k in u for k in ("accounts.google", "freebuff.com/api", "cli", "oauth")):
        events.append({"t": "resp", "s": resp.status, "u": u[:400], "ct": resp.headers.get("content-type", "")[:50]})

def dump_ctx(ctx, tag):
    try:
        for c in ctx.cookies():
            if "freebuff" in c.get("domain", "") or "google" in c.get("domain", ""):
                events.append({"t": "cookie_" + tag, "d": c.get("domain"), "n": c.get("name"), "v": c.get("value", "")[:120]})
    except Exception as e:
        events.append({"t": "cookie_err_" + tag, "e": str(e)})

with Camoufox(headless=True) as browser:
    ctx = browser.new_context(proxy={"server": WARP})
    page = ctx.new_page()
    page.on("request", on_request)
    page.on("response", on_response)
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=90000)
    try:
        page.wait_for_selector("text=Continue with Google", timeout=60000)
    except Exception as e:
        print("NO_GOOGLE_BTN", e)
    page.click("text=Continue with Google", timeout=30000)
    page.wait_for_timeout(5000)
    print("URL1", page.url)
    def find_email_frame():
        for f in page.frames:
            try:
                if f.locator("input[type=email], #identifierId").count() > 0:
                    return f
            except Exception:
                pass
        return None
    try:
        page.wait_for_function(
            "() => [...document.querySelectorAll('iframe')].length > 0 || document.querySelector('input[type=email], #identifierId') !== null",
            timeout=60000)
    except Exception as e:
        print("NO_IFRAME", str(e)[:150])
    page.wait_for_timeout(4000)
    f = find_email_frame()
    if f is None:
        print("STILL_NO_EMAIL_FRAME", page.url)
        page.screenshot(path="/tmp/intel-freebuff-full/g1_email.png")
    else:
        print("GOT_EMAIL_INPUT in frame", f.url[:80])
        page.screenshot(path="/tmp/intel-freebuff-full/g1_email.png")
        f.locator("input[type=email], #identifierId").first.fill(EMAIL)
        f.locator("button:has-text('Next'), #identifierNext").first.click(timeout=15000)
    page.wait_for_timeout(4000)
    page.screenshot(path="/tmp/intel-freebuff-full/g2_pass.png")
    print("URL2", page.url)
    def find_pass_frame():
        for f in page.frames:
            try:
                if f.locator("input[type=password]").count() > 0:
                    return f
            except Exception:
                pass
        return None
    f2 = None
    for i in range(6):
        f2 = find_pass_frame()
        if f2: break
        page.wait_for_timeout(4000)
    if f2 is None:
        print("NO_PASS_INPUT", page.url)
        page.screenshot(path="/tmp/intel-freebuff-full/g2_pass.png")
    else:
        print("GOT_PASS_INPUT in frame", f2.url[:80])
        page.screenshot(path="/tmp/intel-freebuff-full/g2_pass.png")
        f2.locator("input[type=password]:visible").first.fill(PASSW)
        f2.locator("button:has-text('Next'), #passwordNext").first.click(timeout=15000)
        print("PASS_SUBMITTED")
    page.wait_for_timeout(8000)
    # consent screen: click Continue / Allow
    def find_consent_btn():
        for f in page.frames:
            try:
                b = f.locator("button:has-text('Continue'), button:has-text('Allow'), button:has-text('I agree'), button:has-text('Lanjutkan'), #submit_approve_access")
                if b.count() > 0:
                    return b.first
            except Exception:
                pass
        return None
    for i in range(5):
        b = find_consent_btn()
        if b:
            try:
                b.click(timeout=10000)
                print("CONSENT_CLICKED", i)
                break
            except Exception as e:
                print("CONSENT_CLICK_ERR", str(e)[:100])
        page.wait_for_timeout(4000)
    page.wait_for_timeout(12000)
    print("FINAL_URL", page.url)
    page.screenshot(path="/tmp/intel-freebuff-full/g3_final.png")
    dump_ctx(ctx, "after_login")
    for p in ctx.pages:
        print("PAGE", p.url)
    with open("/tmp/intel-freebuff-full/trace_approve.json", "w") as f:
        json.dump(events, f, indent=1)
    print("EVENTS", len(events))
