"""Playwright chromium browser flow for Qoder signup + OTP + device authorize.

Port of qoder_browser.py (Camoufox → plain chromium sync API).
Slider = _slider.solve_slider_v2 (pure JS, no cv2).
"""
import os
import random
import time

from playwright.sync_api import sync_playwright

from ._slider import solve_slider_v2

SIGNUP_URL = "https://qoder.com/users/sign-up"
DEVICE_URL = "https://qoder.com/device/selectAccounts"

_SLIDER_SELS = ("div[class*='slider']", ".captcha-slider-btn", "[role='slider']")
_AUTH_BTNS = ("button:has-text('Authorize')", "button:has-text('approve')",
              "button:has-text('Approve')", "button:has-text('授权')",
              "button:has-text('confirm')", "button:has-text('Confirm')",
              "button:has-text('allow')", "button:has-text('Allow')",
              "button:has-text('select')", "button:has-text('Continue')",
              "button:has-text('continue')", "button[type='submit']")


def _chromium_exe():
    """CHROME_PATH env → explicit executable; else playwright default chromium."""
    exe = os.environ.get("CHROME_PATH", "").strip()
    if exe:
        return exe
    # find chromium in playwright cache as fallback (sync API has no executable_path)
    cache = os.path.expanduser("~/.cache/ms-playwright")
    if os.path.isdir(cache):
        for d in sorted(os.listdir(cache), reverse=True):
            if not d.startswith("chromium-") or "headless" in d:
                continue
            p = os.path.join(cache, d)
            for cand in ("chrome-linux/chrome", "chrome-linux64/chrome",
                         "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
                         "chrome-win/chrome.exe"):
                full = os.path.join(p, cand)
                if os.path.isfile(full):
                    return full
    return None  # let playwright resolve its own default


def _launch(proxy, headless):
    kwargs = {"headless": headless, "args": ["--no-sandbox"]}
    exe = _chromium_exe()
    if exe:
        kwargs["executable_path"] = exe
    if proxy:
        kwargs["proxy"] = {"server": proxy}
    return sync_playwright().start(), kwargs


def _fill_react(page, locator, value):
    """Native setter to trigger React onChange; fallback to fill()."""
    try:
        locator.evaluate(
            "(el, v) => { const s = Object.getOwnPropertyDescriptor("
            "window.HTMLInputElement.prototype, 'value').set; s.call(el, v); "
            "el.dispatchEvent(new Event('input', {bubbles:true})); "
            "el.dispatchEvent(new Event('change', {bubbles:true})); }", value)
    except Exception:
        locator.fill(value)


def run_browser_flow(email, password, first, last, proxy, auth_url, otp_cb, headless=True, log=print):
    """Signup + verify + authorize. Returns True on authorize click.

    Engine: Camoufox (anti-fingerprint, geoip) if installed — chromium fallback.
    Camoufox is required to pass Aliyun captcha (chromium gets TMD-blocked).
    """
    try:
        from camoufox import Camoufox
        return _run_camoufox(email, password, first, last, proxy, auth_url, otp_cb, headless, log)
    except ImportError:
        log("[browser] camoufox not installed — chromium fallback (captcha likely blocked)", flush=True)
    return _run_chromium(email, password, first, last, proxy, auth_url, otp_cb, headless, log)


def _run_camoufox(email, password, first, last, proxy, auth_url, otp_cb, headless, log):
    """Camoufox engine (anti-fingerprint + geoip)."""
    with Camoufox(proxy={"server": proxy} if proxy else None,
                  headless=headless, geoip=True) as browser:
        page = browser.new_page()
        _signup_and_verify(page, email, password, first, last, auth_url, otp_cb, log)
    return True


def _run_chromium(email, password, first, last, proxy, auth_url, otp_cb, headless, log):
    """Chromium engine (fallback)."""
    pw_ctx, launch_kwargs = _launch(proxy, headless)
    try:
        browser = pw_ctx.chromium.launch(**launch_kwargs)
    except Exception as e:
        pw_ctx.stop()
        raise RuntimeError(f"chromium launch failed: {e}") from e
    try:
        page = browser.new_page()
        _signup_and_verify(page, email, password, first, last, auth_url, otp_cb, log)
    finally:
        browser.close()
        pw_ctx.stop()
    return True


def _signup_and_verify(page, email, password, first, last, auth_url, otp_cb, log):

    # 0. navigate to signup
    page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)

    # 1. signup form — language-independent: antd ids #basic_* first, placeholder fallback
    def _fill_any(selectors, value, label):
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                loc.wait_for(state="attached", timeout=8000)
                loc.fill(value, timeout=8000)
                return True
            except Exception:
                continue
        log(f"[browser] {label} fill failed", flush=True)
        return False

    _fill_any(["#basic_firstName", "#basic_first_name",
               "input[placeholder='Enter your first name']"], first, "first name")
    _fill_any(["#basic_lastName", "#basic_last_name",
               "input[placeholder='Enter your Last Name']"], last, "last name")
    _fill_any(["#basic_email", "input[placeholder='Enter your email address']"], email, "email")
    # password field may exist (hidden) — fill via JS setter to bypass visibility
    try:
        pw1 = page.locator("#basic_password").first
        if pw1.count() > 0:
            _fill_react(page, pw1, password)
            log("[browser] password filled in step1 (JS)", flush=True)
    except Exception:
        log("[browser] password step1 skipped", flush=True)
    try:
        chk = page.locator(".ant-checkbox-input")
        if not chk.is_checked():
            chk.click(force=True)
    except Exception:
        log("[browser] checkbox failed", flush=True)
    time.sleep(1)
    try:
        page.click("button[type='submit']")
    except Exception:
        page.click("button:has-text('Continue'), button:has-text('继续')")
    time.sleep(2)

    # 2. password (set after email step) — skip if already filled in step 1
    pw = page.locator("input[type='password']").first
    try:
        pw.wait_for(state="visible", timeout=30000)
        cur = pw.evaluate("(el) => el.value")
    except Exception:
        cur = ""
    if not cur:
        # fill via JS evaluate regardless of visibility (React setter pattern)
        try:
            _fill_react(page, pw, password)
            log("[browser] password filled via JS (hidden field)", flush=True)
        except Exception as e:
            log(f"[browser] pw JS fill err: {e}", flush=True)
            try:
                pw.fill(password)
            except Exception:
                pass
        try:
            pw.scroll_into_view_if_needed(timeout=5000)
        except Exception:
            pass
    else:
        log("[browser] password already filled (step1)", flush=True)
    time.sleep(1)
    page.click("button[type='submit'], button:has-text('Continue'), "
               "button:has-text('Sign up'), button:has-text('注册')")
    time.sleep(2)

    # 3. click-to-verify gate
    try:
        page.click("text=Click to verify")
        log("[browser] verify gate clicked", flush=True)
    except Exception:
        log("[browser] no verify gate (skipped)", flush=True)
    time.sleep(1)

    # 4. Aliyun slider (may appear)
    for attempt in range(3):
        if any(page.locator(sel).count() > 0 for sel in _SLIDER_SELS):
            log(f"[browser] slider attempt {attempt + 1}", flush=True)
            try:
                ok = solve_slider_v2(page, log=log)
                log(f"[browser] slider attempt {attempt + 1} → {ok}", flush=True)
                if ok:
                    break
            except Exception as e:
                log(f"[browser] slider attempt {attempt + 1} EXC: {e}", flush=True)
        else:
            log(f"[browser] no slider (attempt {attempt + 1})", flush=True)
            break
    time.sleep(1)

    # 5. OTP
    code = otp_cb() if otp_cb else None
    log(f"[browser] OTP: {code or 'none'}", flush=True)
    if code:
        try:
            otp_screen = page.locator(
                ".ant-otp-input, input[aria-label*='OTP'], input[maxlength='1']").first
            otp_screen.wait_for(state="visible", timeout=30000)
        except Exception:
            log("[browser] OTP screen not visible", flush=True)
        otp_inputs = page.locator(".ant-otp-input, input[aria-label*='OTP Input']").all()
        if len(otp_inputs) == 6:
            for i, inp in enumerate(otp_inputs):
                inp.fill(code[i])
                page.wait_for_timeout(80)
            log("[browser] OTP filled 6-inputs", flush=True)
        else:
            for inp in page.locator("input").all():
                if inp.get_attribute("maxlength") == "6":
                    inp.fill(code)
                    break
        try:
            page.click("button[type='submit'], button:has-text('Verify'), button:has-text('验证')")
        except Exception:
            pass
        time.sleep(1.5)

    # 6. device authorize — register-only mode if no auth_url
    if not auth_url:
        log("[browser] register-only mode (no device authorize)", flush=True)
        time.sleep(2)
        return True
    try:
        for _ in range(10):
            u = page.url
            if "/sign-in" in u or "/login" in u:
                break
            page.wait_for_timeout(1000)
        if "/sign-in" in page.url or "/login" in page.url:
            log("[browser] session lost, re-login", flush=True)
            try:
                page.locator("input[type='email'], input[placeholder*='email']").first.fill(email)
                page.wait_for_timeout(500)
                page.click("button:has-text('Continue'), button[type='submit']")
                page.wait_for_timeout(2000)
                pw = page.locator("input[type='password']").first
                pw.wait_for(state="visible", timeout=15000)
                pw.fill(password)
                page.wait_for_timeout(300)
                page.click("button[type='submit'], button:has-text('Continue'), button:has-text('Sign in')")
                page.wait_for_timeout(3000)
                log(f"[browser] re-login done, url={page.url[:80]}", flush=True)
            except Exception as e:
                log(f"[browser] re-login failed: {e}", flush=True)
    except Exception:
        pass
    page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
    time.sleep(3)
    try:
        clicked = False
        for sel in _AUTH_BTNS:
            try:
                if page.locator(sel).first.is_visible(timeout=2000):
                    page.locator(sel).first.click(timeout=5000)
                    clicked = True
                    log(f"[browser] authorize clicked via '{sel}'", flush=True)
                    break
            except Exception:
                continue
        if not clicked:
            log(f"[browser] no authorize button found; url={page.url[:80]}", flush=True)
        time.sleep(3)
        log(f"[browser] after authorize url={page.url[:80]}", flush=True)
    except Exception as e:
        log(f"[browser] authorize flow err: {e}", flush=True)

    return True
