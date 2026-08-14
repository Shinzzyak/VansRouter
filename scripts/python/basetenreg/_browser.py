"""Camoufox/Playwright signup flow for Baseten.

Cloudflare JS challenge on login.baseten.co → anti-detect engine required.
Same dual-engine pattern as qoderreg._browser (camoufox → chromium fallback).

Returns session cookies (list of {name, value, domain, path}) so the HTTP
continuation (_http.py) can reuse the authenticated session.
"""
import os
import time

from playwright.sync_api import sync_playwright

SIGNUP_URL = "https://login.baseten.co/sign-up"


def _chromium_exe():
    """CHROME_PATH env → explicit executable; else playwright default chromium."""
    exe = os.environ.get("CHROME_PATH", "").strip()
    if exe:
        return exe
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
    return None


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


def _fill_any(page, selectors, value):
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            loc.wait_for(state="attached", timeout=8000)
            loc.fill(value, timeout=8000)
            return True
        except Exception:
            continue
    return False


def _click_any(page, selectors):
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=2000):
                btn.click(timeout=5000)
                return True
        except Exception:
            continue
    return False


def _fill_otp(page, code):
    otp_inputs = page.locator("input[maxlength='1']").all()
    if len(otp_inputs) >= 6:
        for i, inp in enumerate(otp_inputs[:6]):
            inp.fill(code[i])
            page.wait_for_timeout(80)
        return True
    for inp in page.locator("input").all():
        if inp.get_attribute("maxlength") == "6":
            inp.fill(code)
            return True
    return False


def _collect_cookies(page):
    cookies = []
    for c in page.context.cookies():
        if c.get("name", "").lower().startswith(("__cf", "cf_")):
            continue
        cookies.append({
            "name": c["name"], "value": c["value"],
            "domain": c.get("domain", ""), "path": c.get("path", "/"),
        })
    return cookies


def _signup(page, email, password, first, last, otp_cb, log):
    page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)

    # Cloudflare challenge may auto-pass (camoufox) — wait for the form
    for _ in range(30):
        if page.locator("input[type='email'], input[name='email']").count() > 0:
            break
        page.wait_for_timeout(2000)
    if "Just a moment" in (page.content() or "")[:4000]:
        raise RuntimeError("cloudflare challenge not solved")

    # Flow 2026-08-14: PASSWORDLESS — form cuma email + Continue (no password/name).
    # Email → Continue → OTP code dikirim → masukkan code → redirect ke app.
    _fill_any(page, ["input[type='email']", "input[name='email']",
                     "input[placeholder*='email' i]"], email)

    # submit (continue → send OTP)
    if not _click_any(page, ["button[type='submit']", "button:has-text('Continue')",
                             "button:has-text('Create account')", "button:has-text('Sign up')"]):
        page.keyboard.press("Enter")
    page.wait_for_timeout(3000)

    # OTP step (passwordless code — required)
    code = otp_cb() if otp_cb else None
    log(f"[browser] OTP: {code or 'none'}")
    if code:
        try:
            page.locator("input[maxlength='1'], input[maxlength='6']").first.wait_for(
                state="visible", timeout=30000)
        except Exception:
            log("[browser] OTP screen not visible")
        if _fill_otp(page, code):
            _click_any(page, ["button[type='submit']", "button:has-text('Verify')",
                              "button:has-text('Continue')"])
            page.wait_for_timeout(2000)

    # wait out the magic-code redirect / landing (app.baseten.co = success)
    for _ in range(30):
        u = page.url
        if "app.baseten.co" in u:
            break
        page.wait_for_timeout(2000)


def run_baseten_signup(email, password, first, last, proxy, otp_cb,
                       engine="camoufox", headless=True, log=print):
    """Run browser signup. Returns cookie list on success, raises on failure."""
    if engine == "camoufox":
        try:
            from camoufox import Camoufox
            with Camoufox(proxy={"server": proxy} if proxy else None,
                          headless=headless, geoip=True) as browser:
                page = browser.new_page()
                _signup(page, email, password, first, last, otp_cb, log)
                return _collect_cookies(page)
        except ImportError:
            log("[browser] camoufox not installed — chromium fallback "
                "(Cloudflare may block)")
    return _run_chromium(email, password, first, last, proxy, otp_cb, headless, log)


def _run_chromium(email, password, first, last, proxy, otp_cb, headless, log):
    kwargs = {"headless": headless, "args": ["--no-sandbox"]}
    exe = _chromium_exe()
    if exe:
        kwargs["executable_path"] = exe
    if proxy:
        kwargs["proxy"] = {"server": proxy}
    pw_ctx = sync_playwright().start()
    try:
        browser = pw_ctx.chromium.launch(**kwargs)
    except Exception as e:
        pw_ctx.stop()
        raise RuntimeError(f"chromium launch failed: {e}") from e
    try:
        page = browser.new_page()
        _signup(page, email, password, first, last, otp_cb, log)
        return _collect_cookies(page)
    finally:
        browser.close()
        pw_ctx.stop()
