"""autoclawreg — AutoClaw bulk account creation via Z.ai signup + YYDS temp-mail.

Flow per account:
  1. Create YYDS temp-mail inbox (reuse qoderreg._yyds)
  2. Signup Z.ai (POST /api/v1/auths/signup) with Aliyun slider captcha solve
  3. Verify email (POST /api/v1/auths/verify_email, token from YYDS inbox)
  4. Signin Z.ai → AutoClaw web → extract localStorage tokens
  5. Output JSON lines: {status, access_token, refresh_token, device_id, user_id, user_name}

Reuses qoderreg's _yyds.py (temp-mail) + _slider.py (Aliyun slider solver).
"""

import argparse
import json
import re
import sys
import time
import uuid

ZAI_API = "https://chat.z.ai/api/v1"
AUTOCLAW_WEB_URL = "https://autoclaw.z.ai/web/"
ALIYUN_CAPTCHA_JS = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
# SceneId for chat.z.ai (from prod bundle); fallback for other hosts
ZAI_SCENE_ID = "didk33e0"
FALLBACK_SCENE_ID = "xswyjefn"

try:
    from ._yyds import yyds_create_inbox, yyds_poll_otp
    from ._slider import solve_slider_v2
    from ._shumei_solver import solve as solve_shumei_captcha
    from ._shumei_cv2 import match as solve_shumei_cv2
    from qoderreg._driftz import driftz_create_inbox, driftz_poll_otp
    from qoderreg._tempik import tempik_create_inbox, tempik_poll_otp
except ImportError:  # allow running as standalone script
    from qoderreg._yyds import yyds_create_inbox, yyds_poll_otp
    from qoderreg._slider import solve_slider_v2
    from autoclawreg._shumei_solver import solve as solve_shumei_captcha
    from autoclawreg._shumei_cv2 import match as solve_shumei_cv2
    from qoderreg._driftz import driftz_create_inbox, driftz_poll_otp
    from qoderreg._tempik import tempik_create_inbox, tempik_poll_otp

# Google login selectors (pola kiroGoogleAutomation — selector-driven, locale-agnostic)
GOOGLE_EMAIL_INPUT = [
    'input[type="email"]',
    'input[name="identifier"]',
    '#identifierId',
    'input[aria-label*="email" i]',
    'input[aria-label*="Email"]',
]
GOOGLE_EMAIL_NEXT = [
    '#identifierNext',
    'button[name="action"]',
    'button[jsname*="LgbsSe"]',
    'div#identifierNext button',
]
GOOGLE_PASSWORD_INPUT = [
    'input[type="password"]',
    'input[name="Passwd"]',
    'input[aria-label*="password" i]',
]
GOOGLE_PASSWORD_NEXT = [
    '#passwordNext',
    'button[name="action"]',
    'div#passwordNext button',
]
GOOGLE_ACCOUNT_OPTION = [
    '[data-identifier]',
    '[data-email]',
]
# Shumei captcha — refresh button (kalau ada) + wrapper classes
SHUMEI_REFRESH_BTN = [
    '.shumei_captcha_refresh_btn',
    '.shumei_captcha_footer_refresh_btn',
    '[class*="refresh"]',
    '[class*="reload"]',
]


def random_device_id():
    return "uid_" + uuid.uuid4().hex[:12]


def gen_password():
    return "Zai" + uuid.uuid4().hex[:10] + "!a1"


def signup_zai(session, email, password, device_id, captcha_param=None):
    """POST /auths/signup — returns (ok, response_json_or_error)."""
    body = {
        "name": email.split("@")[0],
        "email": email,
        "password": password,
        "profile_image_url": "",
        "sso_redirect": "",
    }
    if captcha_param:
        body["captcha_verify_param"] = captcha_param
    headers = {"Content-Type": "application/json", "X-Device-ID": device_id}
    r = session.post(f"{ZAI_API}/auths/signup", json=body, headers=headers, timeout=30)
    try:
        data = r.json()
    except Exception:
        return False, {"raw": r.text[:200], "status_code": r.status_code}
    if r.status_code >= 400 or data.get("detail"):
        return False, data
    return True, data


def signin_zai(session, email, password, device_id):
    """POST /auths/signin — returns (ok, data)."""
    body = {"email": email, "password": password}
    headers = {"Content-Type": "application/json", "X-Device-ID": device_id}
    r = session.post(f"{ZAI_API}/auths/signin", json=body, headers=headers, timeout=30)
    try:
        data = r.json()
    except Exception:
        return False, {"raw": r.text[:200], "status_code": r.status_code}
    return r.status_code < 400, data


def extract_autoclaw_tokens(page):
    """Read AutoClaw localStorage tokens from a Playwright page."""
    return page.evaluate(
        """() => {
      const g = k => { try { return localStorage.getItem(k); } catch { return null; } };
      const auth = g('autoclaw.web.authToken');
      const refresh = g('autoclaw.web.refreshToken');
      const device = g('autoclaw.web.deviceId');
      const info = g('autoclaw.web.loginInfo');
      let userId = null, userName = null;
      if (info) { try { const p = JSON.parse(info); userId = p.user_id; userName = p.user_name; } catch {} }
      return { authToken: auth, refreshToken: refresh, deviceId: device, userId, userName };
    }"""
    )


def _click_first_visible(page, selectors, timeout=5000, text=None):
    """Klik elemen pertama yang visible dari daftar selector. Return True/False."""
    import time as _t
    deadline = _t.time() + timeout / 1000
    while _t.time() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=2000)
                    return True
            except Exception:
                continue
        # Fallback: cari by text
        if text:
            try:
                loc = page.get_by_text(text, exact=False).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=2000)
                    return True
            except Exception:
                pass
        _t.sleep(0.5)
    return False


def _fill_first_visible(page, selectors, value, timeout=5000):
    """Isi input pertama yang visible. Return True/False."""
    import time as _t
    deadline = _t.time() + timeout / 1000
    while _t.time() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.fill(value, timeout=2000)
                    return True
            except Exception:
                continue
        _t.sleep(0.5)
    return False


def _solve_shumei_in_page(page, max_attempts=10, oauth_state=None):
    """Deteksi + solve captcha Shumei icon_select di halaman.

    Flow: cari bg+fg img visible → download → solve cv2 → klik koordinat →
    tunggu fverify PASS (SDK auto-submit). Kalau REJECT/gagal → refresh → ulangi.
    Return True kalau captcha PASS (fverify PASS + oauth-url tertangkap, atau
    oauth_state None → popup hilang + fverify PASS).
    """
    import urllib.request
    import tempfile
    import json as _json

    # State: fverify results + oauth_url (intercept via response)
    fverify_state = {"pass": False, "reject": False}

    def on_captcha_resp(resp):
        if "fengkongcloud" in resp.url and "fverify" in resp.url:
            try:
                body = resp.text()[:300]
                if "PASS" in body:
                    fverify_state["pass"] = True
                    print("[captcha] fverify PASS!")
                elif "REJECT" in body:
                    fverify_state["reject"] = True
                    print("[captcha] fverify REJECT")
            except Exception:
                pass

    page.on("response", on_captcha_resp)

    for attempt in range(max_attempts):
        # Reset state per attempt
        fverify_state["pass"] = False
        fverify_state["reject"] = False

        # Cari bg+fg img yang VISIBLE (rect width > 0)
        info = page.evaluate(
            """() => {
            const imgs = [...document.querySelectorAll('img')];
            const bg = imgs.find(i => (i.src || '').includes('_bg.jpg'));
            const fg = imgs.find(i => (i.src || '').includes('_fg.png'));
            if (!bg) return {found: false};
            const r = bg.getBoundingClientRect();
            return {
                found: r.width > 0,
                bg: bg.src, fg: fg ? fg.src : null,
                rect: {x: r.x, y: r.y, w: r.width, h: r.height},
            };
        }"""
        )
        if not info.get("found"):
            print(f"[captcha] attempt {attempt + 1}: captcha TIDAK visible (dianggap lewat)")
            # Kalau oauth-state diminta dan belum tertangkap → masih gagal
            if oauth_state is not None and not oauth_state.get("url"):
                print(f"[captcha] tapi oauth-url belum tertangkap — retry refresh")
                _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=2000)
                time.sleep(1.5)
                continue
            return True  # captcha tidak visible = sudah lewat / tidak ada

        bg_src = info["bg"]
        fg_src = info["fg"]
        box = info["rect"]
        if not fg_src:
            _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=3000)
            time.sleep(1.5)
            continue

        # Download bg+fg ke temp
        tmpdir = tempfile.mkdtemp(prefix="shumei-")
        bg_path = f"{tmpdir}/bg.jpg"
        fg_path = f"{tmpdir}/fg.png"
        try:
            urllib.request.urlretrieve(bg_src, bg_path)
            urllib.request.urlretrieve(fg_src, fg_path)
        except Exception as e:
            print(f"[captcha] download fail: {e}", file=sys.stderr)
            _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=3000)
            time.sleep(1.5)
            continue

        # Solve: cv2 deterministik primary → vision fallback
        clicks = []
        try:
            cv2_clicks, cv2_detail = solve_shumei_cv2(bg_path, fg_path)
            if cv2_clicks and len(cv2_clicks) >= 2:
                clicks = cv2_clicks
                print(f"[captcha] cv2 solver: {cv2_detail}")
        except Exception as e:
            print(f"[captcha] cv2 fail ({e}), fallback vision", file=sys.stderr)

        if len(clicks) < 2:
            res = solve_shumei_captcha(bg_path, fg_path)
            clicks = res.get("clicks", [])
        if not clicks:
            print(f"[captcha] solver no clicks", file=sys.stderr)
            _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=3000)
            time.sleep(1.5)
            continue

        # Klik koordinat (bg 600x300 → scale ke box) — hanya yang valid (bukan 0,0)
        for (x, y) in clicks:
            if float(x) <= 1 and float(y) <= 1:
                continue
            px = box["x"] + float(x) * box["w"] / 600
            py = box["y"] + float(y) * box["h"] / 300
            page.mouse.click(px, py)
            time.sleep(0.6)

        # Tunggu hasil: fverify PASS / popup hilang
        # (SDK auto-submit setelah klik; PASS → popup close + lanjut OAuth)
        time.sleep(3.5)
        if fverify_state["pass"]:
            print(f"[captcha] SOLVED attempt {attempt + 1} (fverify PASS)")
            return True
        if oauth_state is not None and oauth_state.get("url"):
            print(f"[captcha] SOLVED attempt {attempt + 1} (oauth-url tertangkap)")
            return True

        # Belum lolos → klik refresh kalau ada, lalu retry
        print(f"[captcha] attempt {attempt + 1} belum lolos (fverify_pass={fverify_state['pass']}) — retry")
        _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=2000)
        time.sleep(1.5)

    print("[captcha] MAX ATTEMPTS — gagal solve", file=sys.stderr)
    return False


def _google_login(page, email, password):
    """Login Google OAuth — selector-driven (locale-agnostic)."""
    # Tunggu halaman accounts.google.com
    deadline = time.time() + 25
    while time.time() < deadline and "accounts.google.com" not in page.url:
        time.sleep(1)

    # Pilih akun kalau ada list (data-identifier)
    _click_first_visible(page, GOOGLE_ACCOUNT_OPTION, timeout=3000)

    # Email — tunggu input beneran ada (render SPA Google lambat)
    email_input = None
    deadline = time.time() + 15
    while time.time() < deadline:
        for sel in GOOGLE_EMAIL_INPUT:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    email_input = loc
                    break
            except Exception:
                continue
        if email_input:
            break
        time.sleep(0.5)
    if not email_input:
        try:
            page.screenshot(path="/tmp/google_email_fail.png")
            print(f"[google] email input tidak ditemukan. URL: {page.url[:120]}")
        except Exception:
            pass
        return False, "google email input tidak ditemukan"

    try:
        email_input.fill(email, timeout=5000)
        print(f"[google] email terisi: {email[:25]}...")
    except Exception as e:
        print(f"[google] fill gagal ({e}), coba press_sequentially")
        try:
            email_input.click(timeout=2000)
            email_input.press_sequentially(email, delay=30)
            print(f"[google] email terisi via press_sequentially")
        except Exception as e2:
            return False, f"google email fill gagal: {e2}"
    _click_first_visible(page, GOOGLE_EMAIL_NEXT, timeout=8000)
    time.sleep(2)

    # Password
    if not _fill_first_visible(page, GOOGLE_PASSWORD_INPUT, password, timeout=10000):
        # Mungkin email salah / akun tidak ada — debug state
        try:
            page.screenshot(path="/tmp/google_pw_fail.png")
            print(f"[google] password input tidak muncul. URL: {page.url[:150]}")
            print(f"[google] body: {((page.locator('body').inner_text(timeout=3000) or '')[:250]).replace(chr(10), ' | ')}")
        except Exception:
            pass
        return False, "google password input tidak muncul (email ditolak?)"
    _click_first_visible(page, GOOGLE_PASSWORD_NEXT, timeout=8000)
    time.sleep(4)

    # Handle "Akun ini tidak ada" / wrong password cepat — popup bisa sudah redirect
    try:
        body = (page.locator("body").inner_text() or "")[:200]
        for bad in ["wrong password", "incorrect password", "invalid email", "couldn't find", "tidak ditemukan", "salah"]:
            if bad.lower() in body.lower():
                return False, f"google auth ditolak: {bad}"
    except Exception:
        # Popup sudah redirect/closed = sukses lanjut consent
        print("[google] popup pindah halaman setelah password — lanjut")
        return True, ""

    return True, ""


def _zai_flow_google(page, gmail, gpassword, device_id):
    """AutoClaw login via Google OAuth + captcha Shumei solver.

    Flow: autoclaw web → Try for free → Continue with Google → captcha Shumei
    (solve via cv2/vision) → SDK panggil google-oauth-url → popup Google →
    login GSuite → consent → token intercept.

    Catatan RE: setelah captcha fverify PASS, SDK panggil API google-oauth-url
    dan buka popup via window.open. Di headless popup kadang tidak terbuka —
    fallback: intercept response oauth-url dan buka manual.
    """
    import urllib.request
    import json as _json

    oauth_url_captured = {"url": ""}

    def on_oauth_resp(resp):
        if "oauth-url" in resp.url and resp.status == 200:
            try:
                d = _json.loads(resp.text())
                url = d.get("data", {}).get("oauth_url", "")
                if url:
                    oauth_url_captured["url"] = url
                    print(f"[flow] oauth-url captured: {url[:90]}...")
            except Exception:
                pass

    # 1. Buka AutoClaw web
    page.goto(AUTOCLAW_WEB_URL, wait_until="domcontentloaded", timeout=60000)
    time.sleep(6)

    # 2. Klik Try for free (menyiapkan login gate) — retry sampai modal muncul
    for _try in range(3):
        try:
            page.get_by_text("Try for free").first.click(timeout=8000)
            print("[flow] clicked Try for free")
            # Tunggu modal login benar-benar render (SPA lambat via proxy)
            for _w in range(10):
                if page.locator("button:has-text('Continue with Google')").count() > 0:
                    break
                time.sleep(1)
            break
        except Exception:
            time.sleep(3)
    else:
        print("[flow] warning: Try for free tidak bisa diklik")

    # 3. Pasang response listener SEBELUM klik Google — tangkap oauth-url
    page.on("response", on_oauth_resp)

    # 4. Tunggu login gate + klik Continue with Google (poll sampai visible)
    deadline = time.time() + 20
    clicked = False
    while time.time() < deadline:
        for sel in ["button:has-text('Continue with Google')", "a:has-text('Continue with Google')",
                    "[role='button']:has-text('Continue with Google')", "button:has-text('Google')"]:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=4000)
                    clicked = True
                    print("[flow] clicked Continue with Google")
                    break
            except Exception:
                continue
        if clicked:
            break
        # Fallback: klik "Log in" kalau login gate belum terbuka
        try:
            login_btn = page.get_by_text("Log in", exact=True).first
            if login_btn.count() > 0 and login_btn.is_visible():
                login_btn.click(timeout=3000)
                print("[flow] fallback: clicked Log in")
        except Exception:
            pass
        time.sleep(1)
    if not clicked:
        return {"status": "failed", "error": "Continue with Google tidak ditemukan"}

    # 5. Captcha Shumei muncul SETELAH klik Continue with Google — solve.
    #    Loop: kalau setelah solve masih di login gate → klik Google lagi → solve lagi.
    print("[flow] solving Shumei captcha (muncul setelah klik Google)...")
    # Tunggu captcha render (bg img muncul) — poll maks 8s
    for _w in range(8):
        _has_bg = page.evaluate("() => !!document.querySelector('img[src*=\"_bg.jpg\"]')")
        if _has_bg:
            print(f"[flow] captcha muncul setelah {_w + 1}s")
            break
        time.sleep(1)
    captcha_ok = False
    for c_round in range(4):
        captcha_ok = _solve_shumei_in_page(page, max_attempts=10, oauth_state=oauth_url_captured)
        print(f"[flow] round {c_round + 1} captcha solved: {captcha_ok}")
        time.sleep(2)
        # Cek: masih di login gate (tombol Google ada) = captcha close bukan lolos
        still_gate = False
        try:
            still_gate = page.locator("button:has-text('Continue with Google')").first.is_visible()
        except Exception:
            still_gate = False
        if not still_gate:
            print("[flow] login gate hilang — captcha benar-benar lolos, lanjut OAuth")
            break
        # Klik Google lagi → captcha baru
        try:
            page.locator("button:has-text('Continue with Google')").first.click(timeout=4000)
            print(f"[flow] klik Google ulang (round {c_round + 2})")
        except Exception:
            pass
        time.sleep(2)
    print(f"[flow] captcha final: {captcha_ok}")

    # 6. Tunggu popup Google / oauth_url (SDK panggil google-oauth-url setelah PASS)
    time.sleep(3)
    print(f"[flow] URL setelah captcha: {page.url}")
    print(f"[flow] pages count: {len(page.context.pages)}")

    popup = None
    # Popup Google kadang terbuka di window terpisah
    if len(page.context.pages) > 1:
        popup = page.context.pages[-1]
        print(f"[flow] switch ke popup: {popup.url}")

    # Popup tidak terbuka tapi oauth_url tertangkap → buka manual
    if not popup and oauth_url_captured["url"]:
        print("[flow] popup tidak terbuka — buka oauth_url manual")
        try:
            popup = page.context.new_page()
            popup.goto(oauth_url_captured["url"], wait_until="domcontentloaded", timeout=30000)
            print(f"[flow] popup manual: {popup.url[:100]}")
        except Exception as e:
            print(f"[flow] buka oauth_url manual gagal: {e}", file=sys.stderr)

    if popup:
        # Tunggu popup benar-benar siap (SPA Google lambat) sebelum login
        try:
            popup.wait_for_load_state("domcontentloaded", timeout=30000)
        except Exception:
            pass
        time.sleep(3)
        # DEBUG: dump struktur #identifierNext kalau ada
        try:
            _next_dom = popup.evaluate(
                """() => {
                const n = document.querySelector('#identifierNext');
                if (!n) return {found: false};
                return {found: true, tag: n.tagName, role: n.getAttribute('role'),
                        html: n.outerHTML.slice(0, 700)};
            }"""
            )
            print(f"[flow] identifierNext: {_next_dom}")
        except Exception:
            pass
        # Kalau popup ternyata sudah redirect ke accounts.google.com — login
        ok, err = _google_login(popup, gmail, gpassword)
        if not ok:
            return {"status": "failed", "error": f"google login: {err}", "captcha_ok": captcha_ok}
        print("[flow] google login ok")

        # DEBUG: state popup + halaman utama setelah login
        time.sleep(2)
        try:
            print(f"[flow] popup URL setelah login: {popup.url[:130]}")
            popup_body = (popup.locator("body").inner_text(timeout=3000) or "")[:300].replace("\n", " | ")
            print(f"[flow] popup body: {popup_body}")
            popup.screenshot(path="/tmp/popup_after_login.png")
        except Exception:
            print("[flow] popup sudah closed setelah login")
        try:
            main_tokens = extract_autoclaw_tokens(page)
            print(f"[flow] main tokens sekarang: {bool(main_tokens.get('authToken'))}")
        except Exception:
            pass

        # 7. Tunggu redirect balik ke autoclaw + token
        deadline = time.time() + 60
        last_url = ""
        no_change = 0
        while time.time() < deadline:
            # Cek token di halaman utama
            tokens = extract_autoclaw_tokens(page)
            if tokens.get("authToken"):
                tokens["status"] = "ok"
                tokens["email"] = gmail
                tokens["device_id"] = device_id
                return tokens
            # Popup mungkin masih di consent / speedbump Workspace / ToS — klik lanjut
            try:
                if not popup.is_closed():
                    cur = popup.url
                    popup_body = ""
                    try:
                        popup_body = (popup.locator("body").inner_text(timeout=2500) or "")
                    except Exception:
                        pass
                    low = popup_body.lower()
                    # Speedbump Workspace Education: "Welcome to your new account"
                    if ("speedbump" in cur or "workspacetermsofservice" in cur
                            or "welcome to your new" in low or "your school manages" in low):
                        for btn_text in ["Continue", "I understand", "I understand and agree", "Got it", "Next"]:
                            try:
                                btn = popup.get_by_role("button", name=btn_text, exact=False).first
                                if btn.count() > 0 and btn.is_visible():
                                    btn.click(timeout=3000)
                                    print(f"[flow] speedbump clicked: {btn_text}")
                                    break
                            except Exception:
                                continue
                    # ToS / consent — klik tombol spesifik (role=button), bukan teks
                    elif "consent" in cur or "tos" in cur or "terms" in cur or "approve" in low or "allow" in low:
                        for btn_text in ["Continue", "Allow", "Allow access", "Accept", "I agree", "同意", "继续", "接受"]:
                            try:
                                btn = popup.get_by_role("button", name=btn_text, exact=False).first
                                if btn.count() > 0 and btn.is_visible():
                                    btn.click(timeout=3000)
                                    print(f"[flow] consent clicked: {btn_text}")
                                    break
                            except Exception:
                                continue
                    # Progress check: URL tidak berubah 3x berturut → berhenti klik
                    if cur == last_url:
                        no_change += 1
                    else:
                        no_change = 0
                        last_url = cur
                    if no_change >= 3:
                        print(f"[flow] popup stuck di: {cur[:110]} — berhenti klik")
                        try:
                            popup.screenshot(path="/tmp/popup_stuck.png")
                        except Exception:
                            pass
                        break
            except Exception:
                pass
            time.sleep(2)

        page.screenshot(path="/tmp/autoclaw_flow_debug.png")
        return {"status": "failed", "error": "token tidak diterima setelah OAuth",
                "url": page.url, "captcha_ok": captcha_ok}

    # Tidak ada popup & tidak ada oauth_url
    return {"status": "failed",
            "error": "popup Google tidak terbuka & oauth_url tidak tertangkap",
            "captcha_ok": captcha_ok}


def _save_connection(result):
    """Simpan token ke provider VansRouter via Node helper (createProviderConnection)."""
    import subprocess
    import os
    payload = {
        "access_token": result.get("access_token") or result.get("authToken", "").replace("Bearer ", ""),
        "refresh_token": result.get("refresh_token") or result.get("refreshToken", "").replace("Bearer ", ""),
        "device_id": result.get("device_id") or result.get("deviceId", ""),
        "user_id": result.get("user_id") or result.get("userId", ""),
        "user_name": result.get("user_name") or result.get("userName", ""),
        "email": result.get("email", ""),
    }
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "save-autoclaw-connection.mjs")
    try:
        proc = subprocess.run(
            ["node", helper, json.dumps(payload)],
            capture_output=True, text=True, timeout=30,
            cwd=os.path.join(os.path.dirname(helper), "..", "..", ".."),
        )
        out = proc.stdout.strip()
        print(f"[save] {out[:120]}")
        return out
    except Exception as e:
        print(f"[save] gagal: {e}")
        return None


def register_one(engine, proxy_url, yyds_api_key, yyds_domain, headless, dry_run=False,
                 google_login=False, google_email="", google_password=""):
    """Register one AutoClaw account. Returns result dict (JSON-line serializable)."""
    email = None
    inbox_id = None
    try:
        if google_login:
            # Mode GSuite: login existing via Google OAuth + captcha Shumei
            device_id = random_device_id()
            if dry_run:
                return {"status": "dry_run", "email": google_email,
                        "note": "google OAuth login + captcha Shumei vision solver"}
            result = None
            if engine == "camoufox":
                from camoufox import Camoufox
                with Camoufox(headless=headless, geoip=True) as browser:
                    page = browser.new_page()
                    result = _zai_flow_google(page, google_email, google_password, device_id)
            else:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as p:
                    browser_args = []
                    if proxy_url:
                        browser_args.append(f"--proxy-server={proxy_url}")
                    browser = p.chromium.launch(headless=headless, args=browser_args)
                    try:
                        # ignore_https_errors: proxy gateway MITM cert (8081) tidak trusted
                        # untuk autoclaw.z.ai — tanpa ini page.goto ERR_CERT_AUTHORITY_INVALID
                        context = browser.new_context(ignore_https_errors=True)
                        page = context.new_page()
                        result = _zai_flow_google(page, google_email, google_password, device_id)
                    finally:
                        browser.close()
            # Auto-save ke provider VansRouter (akun pool) kalau sukses
            if result and result.get("status") == "ok":
                _save_connection(result)
            return result

        if dry_run:
            email = f"test-{uuid.uuid4().hex[:8]}@yyds.dev"
            return {"status": "dry_run", "email": email,
                    "note": "signup would POST /auths/signup with Aliyun slider"}

        # 1. Temp-mail inbox (YYDS → Driftz → tempik chain, like qoderreg)
        email, inbox_id = _create_inbox_chain(yyds_api_key, yyds_domain)
        if not email:
            return {"status": "failed", "error": "inbox create failed (yyds/driftz/tempik)"}
        password = gen_password()
        device_id = random_device_id()

        # 2. Browser flow: signup + Aliyun slider + verify + AutoClaw login
        if engine == "camoufox":
            from camoufox import Camoufox
            with Camoufox(headless=headless, geoip=True) as browser:
                page = browser.new_page()
                return _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser_args = []
            if proxy_url:
                browser_args.append(f"--proxy-server={proxy_url}")
            browser = p.chromium.launch(headless=headless, args=browser_args)
            try:
                context = browser.new_context()
                page = context.new_page()
                return _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id)
            finally:
                browser.close()
    except Exception as e:
        return {"status": "failed", "error": str(e), "email": email}


def _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id):
    """Z.ai signup + Aliyun slider + verify + AutoClaw token extraction on a page."""
    # Load Aliyun captcha lib + signup page
    page.goto(f"{ZAI_API}/auths/signup", wait_until="domcontentloaded")
    page.add_script_tag(url=ALIYUN_CAPTCHA_JS)

    # Solve Aliyun slider if present
    captcha_param = solve_slider_v2(page)
    if not captcha_param:
        return {"status": "failed", "error": "captcha solve failed", "email": email}

    ok, data = signup_zai_http(email, password, device_id, captcha_param)
    if not ok:
        return {"status": "failed", "error": str(data.get("detail") or data), "email": email}

    # 3. Verify email — wait for inbox code
    token = wait_for_verify_token(yyds_api_key, yyds_domain, inbox_id, email)
    if not token:
        return {"status": "failed", "error": "verify email token not received", "email": email}

    # 4. Signin + AutoClaw
    page.goto(AUTOCLAW_WEB_URL, wait_until="domcontentloaded")
    page.evaluate(f"""() => {{
      localStorage.setItem('autoclaw.web.authToken', '{data.get('token') or ''}');
      localStorage.setItem('autoclaw.web.refreshToken', '{data.get('refresh_token') or ''}');
      localStorage.setItem('autoclaw.web.deviceId', '{device_id}');
    }}""")
    tokens = extract_autoclaw_tokens(page)

    return {
        "status": "ok",
        "email": email,
        "access_token": tokens.get("authToken") or data.get("token") or "",
        "refresh_token": tokens.get("refreshToken") or data.get("refresh_token") or "",
        "device_id": tokens.get("deviceId") or device_id,
        "user_id": tokens.get("userId"),
        "user_name": tokens.get("userName"),
    }


def signup_zai_http(email, password, device_id, captcha_param):
    """Direct HTTP signup (no browser) — for API-mode when captcha already solved."""
    import urllib.request
    body = json.dumps({
        "name": email.split("@")[0], "email": email, "password": password,
        "profile_image_url": "", "sso_redirect": "", "captcha_verify_param": captcha_param,
    }).encode()
    req = urllib.request.Request(f"{ZAI_API}/auths/signup", data=body,
                                 headers={"Content-Type": "application/json",
                                          "X-Device-ID": device_id})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, json.loads(resp.read())
    except Exception as e:
        return False, {"detail": str(e)}


def _create_inbox_chain(api_key, domain):
    """YYDS → Driftz → tempik. Returns (email, inbox_id) or (None, None)."""
    if api_key:
        try:
            inbox = yyds_create_inbox(api_key, domain)
            if inbox:
                return inbox
        except Exception as e:
            print(f"[mail] YYDS failed ({e}) → driftz fallback", file=sys.stderr)
    try:
        inbox = driftz_create_inbox()
        if inbox:
            return inbox
    except Exception as e:
        print(f"[mail] driftz failed ({e}) → tempik fallback", file=sys.stderr)
    try:
        return tempik_create_inbox()
    except Exception as e:
        print(f"[mail] tempik failed ({e})", file=sys.stderr)
        return None, None


def _poll_otp_chain(api_key, inbox_id, email, timeout_s=180):
    """YYDS → Driftz → tempik OTP poll. Returns code string or None."""
    if api_key and inbox_id:
        try:
            c = yyds_poll_otp(api_key, inbox_id, timeout_s=timeout_s)
            if c:
                return c
        except Exception:
            pass
    try:
        c = driftz_poll_otp(email, timeout_s=timeout_s)
        if c:
            return c
    except Exception:
        pass
    try:
        return tempik_poll_otp(email, timeout_s=timeout_s, session_id=inbox_id)
    except Exception:
        return None


def wait_for_verify_token(yyds_api_key, yyds_domain, inbox_id, email, timeout_s=180):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        code = _poll_otp_chain(yyds_api_key, inbox_id, email, timeout_s=60)
        if code:
            m = re.search(r"verify[^\s]*token=([A-Za-z0-9._-]+)", code)
            if m:
                return m.group(1)
        time.sleep(10)
    return None


def main():
    parser = argparse.ArgumentParser(description="AutoClaw bulk registration via Z.ai signup (YYDS temp-mail)")
    parser.add_argument("--count", type=int, default=1, help="number of accounts")
    parser.add_argument("--yyds-api-key", required=True)
    parser.add_argument("--yyds-domain", default="")
    parser.add_argument("--proxy", default="", help="socks5://host:port")
    parser.add_argument("--engine", choices=["chromium", "camoufox"], default="chromium")
    parser.add_argument("--headless", action="store_true", default=True,
                        help="run headless (default True — no XServer on VPS; use xvfb-run if headed)")
    parser.add_argument("--dry-run", action="store_true", help="print plan only, no signup")
    parser.add_argument("--google-login", action="store_true",
                        help="mode GSuite: login existing via Google OAuth + captcha Shumei")
    parser.add_argument("--google-email", default="", help="GSuite email (mode google-login)")
    parser.add_argument("--google-password", default="", help="GSuite password (mode google-login)")
    parser.add_argument("--accounts-file", default="",
                        help="file email:password per baris (bulk google-login)")
    args = parser.parse_args()

    if args.accounts_file:
        # Bulk mode: baca file email:password
        with open(args.accounts_file) as f:
            accounts = [line.strip() for line in f if line.strip() and not line.startswith("#")]
        for line in accounts[:args.count]:
            parts = line.split(":", 1)
            if len(parts) != 2:
                print(json.dumps({"status": "failed", "error": f"bad line: {line[:40]}"}))
                continue
            gmail, gpass = parts[0].strip(), parts[1].strip()
            result = register_one(
                engine=args.engine, proxy_url=args.proxy,
                yyds_api_key=args.yyds_api_key, yyds_domain=args.yyds_domain,
                headless=args.headless, dry_run=args.dry_run,
                google_login=True, google_email=gmail, google_password=gpass,
            )
            print(json.dumps(result))
            sys.stdout.flush()
        return

    for i in range(args.count):
        result = register_one(
            engine=args.engine, proxy_url=args.proxy,
            yyds_api_key=args.yyds_api_key, yyds_domain=args.yyds_domain,
            headless=args.headless, dry_run=args.dry_run,
            google_login=args.google_login,
            google_email=args.google_email, google_password=args.google_password,
        )
        print(json.dumps(result))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
