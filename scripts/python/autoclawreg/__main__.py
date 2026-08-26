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
import random
import re
import sys
import time
import uuid

ZAI_API = "https://chat.z.ai/api/v1"
AUTOCLAW_WEB_URL = "https://autoclaw.z.ai/web/"
# AutoClaw sign secret (dari bundle electron — X-Auth-Sign = MD5(appid&ts&secret))
AUTOCLAW_SIGN_SECRET = "38d2391985e2369a5fb8227d8e6cd5e5"
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


def exchange_google_oauth_code(code, state, device_id):
    """Exchange Google OAuth code+state -> access/refresh token (electron flow).

    POST /userapi/overseasv1/google-oauth-login
    Body: {code, state, navigate_uri, flow_type: "web", client_type: "web"}
    Signature headers sama seperti /userapi/v1/refresh.
    """
    body = {
        "device_id": device_id,
        "source_id": "web",
        "code": code,
        "state": state,
        "navigate_uri": "https://autoglm-api.autoglm.ai/userapi/oauth/google/callback",
        "flow_type": "web",
        "client_type": "web",
    }
    return exchange_google_oauth_body(body)


def exchange_google_oauth_body(body, cookie_str="", proxy_cfg=None):
    """POST google-oauth-login dengan body persis (dipakai untuk replay req oauth-url).

    proxy_cfg: dict dari _parse_proxy (server/username/password) — WAJIB sama dengan
    IP browser flow, karena server validasi kesamaan IP antara oauth-url & exchange.
    JIKA server/username/password ada → embed creds di URL proxy agar urllib
    ProxyHandler auth otomatis (tanpa ProxyBasicAuthHandler — 407 di proxy webshare)."""
    import urllib.request
    import urllib.error
    import hashlib as _hl
    ts = str(int(time.time()))  # EPOCH SECOND (bukan ms) — sesuai ts() di electron bundle
    sign = _hl.md5(f"100003&{ts}&{AUTOCLAW_SIGN_SECRET}".encode()).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "X-Version": "1.12.1",
        "X-Tm": "web",
        "X-Product": "autoclaw",
        "X-Client-Type": "web",
        "X-Channel": "official",  # electron pakai "official", bukan "web"!
        "X-Auth-Appid": "100003",
        "X-Auth-TimeStamp": ts,
        "X-Auth-Sign": sign,
        "X-Trace-Id": str(uuid.uuid4()),  # qo() = crypto.randomUUID(), BUKAN epoch ms
        "X-Lang": "en",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "Origin": "https://autoclaw.z.ai",
        "Referer": "https://autoclaw.z.ai/",
    }
    if cookie_str:
        headers["Cookie"] = cookie_str
    req = urllib.request.Request(
        "https://autoglm-api.autoglm.ai/userapi/overseasv1/google-oauth-login",
        data=json.dumps(body).encode(), method="POST", headers=headers)
    # Proxy handler — embed creds di URL supaya urllib auto-auth (ProxyBasicAuthHandler
    # gagal dengan 407 di webshare; URL ://user:pass@host:port langsung diterima)
    proxy_url = None
    proxy_dict = None
    if proxy_cfg and proxy_cfg.get("server"):
        server = proxy_cfg["server"]
        # pertahankan scheme (socks5:// tetap socks5 untuk PySocks; http→http)
        scheme = server.split("://", 1)[0] if "://" in server else "http"
        base = server.split("://", 1)[1] if "://" in server else server
        if proxy_cfg.get("username"):
            user = proxy_cfg["username"]
            pw = proxy_cfg.get("password", "")
            proxy_url = f"{scheme}://{user}:{pw}@{base}"
        else:
            proxy_url = server
        # dict proxy untuk requests (supports socks5://host:port native)
        proxy_dict = {"http": proxy_url, "https": proxy_url}
    # requests + PySocks: dukung socks5 (urllib tidak; \u0005\u0000 = SOCKS greeting baca sbg HTTP)
    try:
        import requests as _req
        r = _req.post(
            "https://autoglm-api.autoglm.ai/userapi/overseasv1/google-oauth-login",
            data=json.dumps(body).encode(),
            headers=headers,
            proxies=proxy_dict,
            timeout=45,
        )
        try:
            return r.json()
        except Exception:
            return {"error": r.text[:300]}
    except Exception as e:
        print(f"[exchange] requests gagal ({e}) — fallback urllib", file=sys.stderr)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        if proxy_url else urllib.request.ProxyHandler()
    )
    try:
        with opener.open(req, timeout=45) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


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
    fverify_state = {"pass": False, "reject": False, "ever_passed": False}

    def on_captcha_resp(resp):
        if "fengkongcloud" in resp.url and "fverify" in resp.url:
            try:
                body = resp.text()[:300]
                if "PASS" in body:
                    fverify_state["pass"] = True
                    fverify_state["ever_passed"] = True
                    print("[captcha] fverify PASS!")
                elif "REJECT" in body:
                    fverify_state["reject"] = True
                    print("[captcha] fverify REJECT")
            except Exception:
                pass

    page.on("response", on_captcha_resp)

    captcha_gone = False
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
            captcha_gone = True
            # fverify PASS / captcha hilang = SDK sudah lanjut — JANGAN refresh, biarkan
            if fverify_state["pass"] or fverify_state["ever_passed"]:
                print(f"[captcha] fverify PASS — captcha hilang, biarkan SDK lanjut OAuth")
                return True
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

        # Solve: vision primary (cv2 return klik "cocok" tapi fverify REJECT 100% — cv2
        # template-matching tidak paham instruksi FG; vision model paham urutan ikon)
        clicks = []
        try:
            try:
                from autoclawreg._shumei_hybrid import match as solve_shumei_hybrid
            except ImportError:
                from _shumei_hybrid import match as solve_shumei_hybrid
            hybrid_clicks, hybrid_detail = solve_shumei_hybrid(bg_path, fg_path)
            if hybrid_clicks and len(hybrid_clicks) >= 2:
                clicks = hybrid_clicks
                print(f"[captcha] hybrid solver: {len(clicks)} clicks (strategy={hybrid_detail.get('strategy')})")
        except Exception as e:
            print(f"[captcha] hybrid fail ({e}), fallback vision", file=sys.stderr)
        if len(clicks) < 2:
            try:
                res = solve_shumei_captcha(bg_path, fg_path)
                clicks = res.get("clicks", [])
                if clicks:
                    print(f"[captcha] vision solver: {len(clicks)} clicks (model={res.get('model')})")
            except Exception as e:
                print(f"[captcha] vision fail ({e}), fallback cv2", file=sys.stderr)

        if len(clicks) < 2:
            try:
                cv2_clicks, cv2_detail = solve_shumei_cv2(bg_path, fg_path)
                if cv2_clicks and len(cv2_clicks) >= 2:
                    clicks = cv2_clicks
                    print(f"[captcha] cv2 solver: {cv2_detail}")
            except Exception as e:
                print(f"[captcha] cv2 fail ({e})", file=sys.stderr)
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
        if oauth_state is not None and oauth_state.get("url"):
            print(f"[captcha] SOLVED attempt {attempt + 1} (oauth-url tertangkap)")
            return True
        # fverify PASS dicatat — keluar dari loop solve, biarkan SDK lanjut OAuth
        if fverify_state["pass"] or fverify_state.get("ever_passed", False) or captcha_gone:
            print(f"[captcha] fverify PASS / captcha gone — lanjut ke OAuth (tunggu oauth-url via SDK)")
            return True
        print(f"[captcha] attempt {attempt + 1} belum lolos (fverify_pass={fverify_state['pass']}) — retry")
        _click_first_visible(page, SHUMEI_REFRESH_BTN, timeout=2000)
        time.sleep(1.5)

    print("[captcha] MAX ATTEMPTS — gagal solve", file=sys.stderr)
    return False


# Marker set (pola kiroGoogleAutomation.js ArfanZaky/9router_azaky)
GOOGLE_CHALLENGE_MARKERS = [
    "Type the text you hear", "Type the text you see", "select all", "verify it's you",
    "verify it’s you", "unusual activity", "suspicious sign-in", "try again later",
    "check your phone", "2-step verification", "confirm it's you", "captcha",
    "检测到异常", "请验证", "验证您的身份", "确认是您本人",
]
# Consent: hanya TOMBOL (button / [role=button]) — teks "Continue" di body halaman
# pengantar akan false-match kalau dijadikan teks biasa.
GOOGLE_CONSENT_MARKERS = ["I agree", "Agree", "Accept all", "Accept", "I understand"]
GOOGLE_SPEEDBUMP_MARKERS = ["I understand", "You're signed out", "account recovery"]


def _human_mouse(page, lo=80, hi=380, yo=120, yo2=300):
    """Randomized mouse move + micro-delay (pola kiroGoogleAutomation — anti-bot)."""
    import random
    page.mouse.move(100 + random.randint(lo, hi), 150 + random.randint(yo, yo2))
    time.sleep(0.2 + random.random() * 0.4)


def _read_body_text(pg, timeout=1500):
    try:
        return (pg.locator("body").inner_text(timeout=timeout) or "").lower()
    except Exception:
        return ""


def _click_any_text(pg, texts, timeout=3000):
    """Klik teks pertama yang ada — HANYA button/[role=button] (consent/speedbump)."""
    for t in texts:
        try:
            loc = pg.locator(
                f'button:has-text("{t}"), [role="button"]:has-text("{t}")'
            ).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=timeout)
                time.sleep(1)
                return True
        except Exception:
            continue
    return False


def _google_login(page, email, password):
    """Login Google OAuth — state-machine loop (pola kiroGoogleAutomation.js).

    Loop sampai:
    - URL pindah dari accounts.google.com (sukses → consent/redirect)
    - Challenge terdeteksi → return (False, "challenge:<marker>") — runner/retry layer
      akan putuskan (ganti proxy / needs_manual) — JANGAN coba bruteforce.
    - Invalid credentials → return (False, "invalid_credentials")
    - Email/password field ditemukan → isi dengan humanized input.
    Consent / speedbump / onboarding di-handle inline (klik tombol).
    """
    import random
    deadline = time.time() + 90
    last_state = ""
    while time.time() < deadline:
        url = page.url or ""
        body = _read_body_text(page)

        # 1. Challenge markers — stop, laporkan (jangan buang waktu)
        for m in GOOGLE_CHALLENGE_MARKERS:
            if m.lower() in body:
                print(f"[google] CHALLENGE DETECTED: '{m}' — needs_manual")
                try:
                    page.screenshot(path="/tmp/google_challenge.png")
                except Exception:
                    pass
                return False, f"challenge:{m}"

        # 2. Invalid credentials
        for bad in ["wrong password", "incorrect password", "couldn't find your google account",
                    "couldn’t find your google account", "couldn't sign you in",
                    "enter a valid email"]:
            if bad in body:
                return False, "invalid_credentials"

        # 3. Halaman sudah keluar dari google auth (consent/redirect/closed)
        if "accounts.google.com" not in url:
            # Popup sudah redirect = sukses sampai consent
            print(f"[google] keluar dari accounts.google.com → {url[:80]}")
            return True, ""

        # 4. Consent / speedbump buttons
        if _click_any_text(page, GOOGLE_CONSENT_MARKERS, timeout=1500):
            print("[google] consent button clicked")
            continue
        if _click_any_text(page, GOOGLE_SPEEDBUMP_MARKERS, timeout=1500):
            print("[google] speedbump/onboarding clicked")
            continue

        # 5. Email field
        em = page.locator('input[type="email"], input[name="identifier"], #identifierId').first
        try:
            if em.count() > 0 and em.is_visible():
                _human_mouse(page)
                em.click(timeout=3000)
                em.fill(email, timeout=5000)
                print(f"[google] email terisi: {email[:25]}...")
                time.sleep(0.4 + random.random() * 0.5)
                _human_mouse(page)
                page.locator('#identifierNext, button[name="action"], button[jsname*="LgbsSe"]').first.click(timeout=6000)
                time.sleep(1.5)
                state = "email_sent"
                if state != last_state:
                    print(f"[google] {state}")
                    last_state = state
                continue
        except Exception:
            pass

        # 6. Password field
        pw = page.locator('input[type="password"], input[name="Passwd"]').first
        try:
            if pw.count() > 0 and pw.is_visible():
                _human_mouse(page)
                pw.click(timeout=3000)
                pw.fill(password, timeout=5000)
                print("[google] password terisi")
                time.sleep(0.4 + random.random() * 0.5)
                _human_mouse(page)
                page.locator('#passwordNext, button[name="action"]').first.click(timeout=6000)
                time.sleep(2)
                continue
        except Exception:
            pass

        time.sleep(0.7)

    return False, "google login timeout (90s)"


def _zai_flow_google(page, gmail, gpassword, device_id, invite_code="", proxy_cfg=None, popup_proxy=None):
    """AutoClaw login via Google OAuth + captcha Shumei solver.

    Flow: autoclaw web → Try for free → Continue with Google → captcha Shumei
    (solve via cv2/vision) → SDK panggil google-oauth-url → popup Google →
    login GSuite → consent → token intercept.

    popup_proxy: proxy config (dict) untuk context POPUP Google terpisah.
    IP mobile bersih menghindari Google challenge/rate-limit yang menimpa IP VPS.

    Catatan RE: setelah captcha fverify PASS, SDK panggil API google-oauth-url
    dan buka popup via window.open. Di headless popup kadang tidak terbuka —
    fallback: intercept response oauth-url dan buka manual.

    invite_code: IC reff chain — kalau diisi, buka autoclaw via /?IC=<code>
    sehingga server auto-bind inviter saat OAuth callback (fission reward).
    """
    import urllib.request
    import json as _json

    # Reff chain: buka dengan IC param — bind terjadi server-side saat callback.
    start_url = f"{AUTOCLAW_WEB_URL}?IC={invite_code}" if invite_code else AUTOCLAW_WEB_URL

    oauth_url_captured = {"url": "", "req_body": None}
    # CATATAN: route intercept **/* TERBUKTI memblokir render SPA (test_route_intercept.py).
    # SPA tidak pernah render gate / login saat context.route global aktif → JANGAN dipakai.
    # SPA web TIDAK punya handler google-oauth-login (grep -1 di bundle), jadi code callback
    # TIDAK dikonsumsi SPA — code tetap valid untuk exchange manual kita.
    # TARGETED intercept: HANYA abort POST /google-oauth-login di popup → code tidak hangus
    # (electron cs()→as() juga exchange di popup context → code dipakai duluan → 631001)
    electron_exchange_body = {}  # body yang electron as() mau kirim (capture dari intercept)

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
            # Ambil REQUEST body persis (device_id, rid, navigate_uri yang dipakai halaman)
            try:
                req = resp.request
                pb = req.post_data
                if pb:
                    oauth_url_captured["req_body"] = _json.loads(pb)
                    print(f"[flow] oauth-url REQ body: {pb}")
            except Exception:
                pass

    # Listener CONTEXT-level: popup Google→backend callback TIDAK terlihat dari page.on.
    def on_ctx_resp(resp):
        try:
            u = resp.url
        except Exception:
            return
        if "/userapi/oauth/google/callback" in u or ("/userapi/" in u and "callback" in u):
            try:
                loc = resp.headers.get("location", "")
                body_snip = ""
                try:
                    body_snip = resp.text()[:400]
                except Exception:
                    pass
                set_cookie = resp.headers.get("set-cookie", "")
                print(f"[flow] CB RESP: status={resp.status} loc={loc}")
                print(f"[flow] CB BODY: {body_snip[:350]}")
                if set_cookie:
                    print(f"[flow] CB SET-COOKIE: {set_cookie[:200]}")
            except Exception:
                pass

    try:
        page.context.on("response", on_ctx_resp)
        print("[flow] context response listener aktif")
    except Exception as e:
        print(f"[flow] context listener gagal: {e}")

    # TARGETED route intercept: HANYA block POST google-oauth-login (supaya electron as()
    # di popup TIDAK consume code). Route **/* memblokir render SPA, tapi route spesifik aman.
    def on_login_route(route):
        try:
            u = route.request.url
            method = route.request.method
        except Exception:
            method = ""
            u = ""
        if method == "POST" and "google-oauth-login" in u:
            try:
                body = route.request.post_data
                if body:
                    electron_exchange_body.update(_json.loads(body))
                    print(f"[flow] ELECTRON EXCHANGE INTERCEPTED: body keys={list(_json.loads(body).keys())}")
                    print(f"[flow] ELECTRON EXCHANGE FULL BODY: {body[:800]}")
                    # CAPTURE HEADERS — elektron mungkin kirim header tambahan
                    try:
                        hdrs = dict(route.request.headers)
                        print(f"[flow] ELECTRON EXCHANGE HEADERS: {_json.dumps({k: v for k, v in hdrs.items() if k.lower().startswith('x-') or k.lower() in ('authorization','content-type')})[:800]}")
                    except Exception as e2:
                        print(f"[flow] header capture gagal: {e2}")
            except Exception:
                pass
            # FULFILL dengan dummy (bukan abort) — supaya electron kira exchange gagal,
            # dan request TIDAK sampai ke server (code tetap fresh untuk exchange kita)
            route.fulfill(status=200, content_type="application/json",
                          body=_json.dumps({"code": -1, "msg": "intercepted"}))
            return
        route.continue_()

    try:
        page.context.route("**/google-oauth-login*", on_login_route)
        print("[flow] targeted route intercept aktif (block google-oauth-login)")
    except Exception as e:
        print(f"[flow] targeted route intercept gagal: {e}")

    # 1. Buka AutoClaw web (dengan IC reff kalau ada)
    page.goto(start_url, wait_until="domcontentloaded", timeout=60000)
    time.sleep(6)

    # 2. Klik Try for free (menyiapkan login gate) — POLL sampai render (SPA lambat via proxy)
    #    CATATAN: kadang halaman langsung ke login gate (tanpa Try for free)
    try_for_free_clicked = False
    _tff_deadline = time.time() + 300
    while time.time() < _tff_deadline and not try_for_free_clicked:
        # JS: klik elemen 'Log in' apapun tag-nya (SPAN .figma-sidebar-cloud-empty-action)
        try:
            opened = page.evaluate(
                """() => {
                  const els = [...document.querySelectorAll('*')];
                  const li = els.find(e => (e.textContent||'').trim() === 'Log in' && !!(e.offsetWidth||e.offsetHeight));
                  if (li) { li.click(); return true; }
                  return false;
                }"""
            )
            if opened:
                print("[flow] JS clicked Log in (open gate elemen)")
                try_for_free_clicked = True
                break
        except Exception:
            pass
        # Lalu "Try for free" (teks)
        try:
            page.get_by_text("Try for free").first.click(timeout=4000)
            print("[flow] clicked Try for free")
            try_for_free_clicked = True
            for _w in range(15):
                if page.locator("*:has-text('Continue with Google')").count() > 0:
                    break
                time.sleep(1)
            break
        except Exception:
            time.sleep(2)
    if not try_for_free_clicked:
        print("[flow] warning: Try for free tidak bisa diklik (mungkin sudah di login gate — lanjut)")

    # 3. Pasang response listener SEBELUM klik Google — tangkap oauth-url
    page.on("response", on_oauth_resp)

    # 4. Tunggu login gate + klik Continue with Google — gunakan JS click (non-button safe)
    #    Tombol di halaman ini adalah SPAN/div (bukan <button>), selector button: gagal.
    deadline = time.time() + 120
    clicked = False
    last_url_seen = ""
    while time.time() < deadline:
        # Kalau modal belum terbuka & masih landing: klik "Log in" (JS)
        try:
            open_gate = page.evaluate(
                """() => {
                  const els = [...document.querySelectorAll('*')];
                  // Klik elemen 'Log in' (SPAN .figma-sidebar-cloud-empty-action)
                  const li = els.find(e => (e.textContent||'').trim() === 'Log in' && !!(e.offsetWidth||e.offsetHeight));
                  if (li) { li.click(); return 'login'; }
                  return false;
                }"""
            )
            if open_gate:
                print(f"[flow] JS clicked Log in (open gate): {open_gate}")
        except Exception:
            pass
        time.sleep(4)
        # Cari "Continue with Google" di SEMUA elemen (termasuk non-button)
        try:
            ok_js = page.evaluate(
                """() => {
                  const els = [...document.querySelectorAll('button, a, [role="button"], div, span')];
                  const el = els.find(e => (e.textContent||'').trim().startsWith('Continue with Google') && !!(e.offsetWidth||e.offsetHeight));
                  if (el) { el.click(); return true; }
                  return false;
                }"""
            )
            if ok_js:
                clicked = True
                print("[flow] clicked Continue with Google (JS)")
                break
        except Exception:
            pass
        # Cek URL (progress: kalau sudah redirect ke google, tombol sudah terklik)
        try:
            if page.url != last_url_seen:
                last_url_seen = page.url
                print(f"[flow] url berubah: {page.url[:100]}")
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
    #    SDK async — poll oauth_url_captured sampai 30s sebelum fallback manual
    for _retry_g in range(3):  # maks 3x: klik Google ulang kalau SDK tidak trigger
        for _w in range(15):
            if oauth_url_captured["url"]:
                print(f"[flow] oauth-url tertangkap setelah {_w + 1}s (SDK async)")
                break
            if len(page.context.pages) > 1:
                break
            time.sleep(1)
        if oauth_url_captured["url"] or len(page.context.pages) > 1:
            break
        print(f"[flow] oauth-url belum tertangkap (retry {_retry_g + 1}/3) — klik Continue with Google ulang")
        try:
            page.locator("button:has-text('Continue with Google')").first.click(timeout=4000)
        except Exception:
            try:
                page.evaluate(
                    """() => {
                      const els = [...document.querySelectorAll('button, a, [role="button"], div, span')];
                      const el = els.find(e => (e.textContent||'').trim().startsWith('Continue with Google') && !!(e.offsetWidth||e.offsetHeight));
                      if (el) { el.click(); return true; }
                      return false;
                    }"""
                )
            except Exception:
                pass
        time.sleep(4)
    time.sleep(3)
    print(f"[flow] URL setelah captcha: {page.url}")
    print(f"[flow] pages count: {len(page.context.pages)}")

    popup = None
    popup_ctx = None
    # Popup Google kadang terbuka di window terpisah
    if len(page.context.pages) > 1:
        popup = page.context.pages[-1]
        print(f"[flow] switch ke popup: {popup.url}")

    # Popup tidak terbuka tapi oauth_url tertangkap → buka manual.
    # KALAU popup_proxy diset: buka di CONTEXT MOBILE terpisah (IP bersih → Google
    # tidak kasih challenge). SPA utama tetap di context aslinya (render cepat).
    if not popup or popup_proxy:
        if oauth_url_captured["url"]:
            try:
                if popup_proxy:
                    # context baru dengan proxy mobile — lewat browser yang sama
                    popup_ctx = page.context.browser.new_context(
                        ignore_https_errors=True, proxy=popup_proxy)
                    # interceptor SAMA di popup_ctx: block POST google-oauth-login
                    # supaya SPA autoclaw di popup TIDAK consume code duluan (631001)
                    try:
                        popup_ctx.route("**/google-oauth-login*", on_login_route)
                        print("[flow] popup_ctx route intercept aktif")
                    except Exception as ie:
                        print(f"[flow] popup_ctx intercept gagal: {ie}")
                    # close popup asli (race code ganda)
                    try:
                        if page.context.pages and len(page.context.pages) > 1:
                            for pp in list(page.context.pages)[1:]:
                                pp.close()
                    except Exception:
                        pass
                    popup = popup_ctx.new_page()
                    popup.goto(oauth_url_captured["url"], wait_until="domcontentloaded", timeout=45000)
                    print(f"[flow] popup MOBILE context: {popup.url[:80]}")
                else:
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
            if err.startswith("challenge:"):
                return {"status": "failed", "error": err, "captcha_ok": captcha_ok,
                        "retryable": "proxy_rot"
                        }
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
        exchanged = False
        while time.time() < deadline:
            # 7a. Kalau popup URL sudah berisi ?code= (Google callback) → exchange via API
            if not exchanged:
                try:
                    cur_popup_url = str(popup.url if not popup.is_closed() else page.url)
                except Exception:
                    cur_popup_url = str(page.url)
                if "code=" in cur_popup_url and "autoclaw" in cur_popup_url:
                    from urllib.parse import urlparse, parse_qs
                    qs = parse_qs(urlparse(cur_popup_url).query)
                    code = (qs.get("code") or [""])[0]
                    # State INTERNAL = dari URL popup callback (aosi.*), BUKAN dari oauth-url (agwcb.*).
                    # Backend meneruskan: ?state=aosi.eyJ...&webOAuthCallback=google
                    # on() electron: state = searchParams.get("state") = aosi.*
                    # as(e): e.state = aosi.* → dikirim ke google-oauth-login
                    ostate = (qs.get("state") or [""])[0]
                    print(f"[flow] callback state dari URL popup: len={len(ostate)} prefix={ostate[:20]}")
                    # navigate_uri dari callback URL
                    cb_nav = (qs.get("navigate_uri") or [""])[0]
                    if not cb_nav:
                        try:
                            cb_nav = (parse_qs(urlparse(cur_popup_url.replace("%3D", "=").replace("&amp;", "&")).query).get("navigate_uri") or [""])[0]
                        except Exception:
                            cb_nav = ""
                    print(f"[flow] callback navigate_uri: {cb_nav[:110]}")
                    print(f"[flow] callback code detected ({len(code)} chars) — exchange (state len {len(ostate)})...")
                    if code:
                        # PREFER electron_exchange_body, tapi device_id WAJIB dari oauth-url
                        # (req_body). Kalau electron body device_id beda (muncul pas popup di
                        # context mobile kosong → device baru), server autoclaw tolak 631001.
                        # stephanie sukses = device_id oauth-url == exchange body.
                        oauth_dev = (oauth_url_captured.get("req_body") or {}).get("device_id", "")
                        if electron_exchange_body:
                            rb = dict(electron_exchange_body)
                            if oauth_dev:
                                rb["device_id"] = oauth_dev
                            print(f"[flow] pakai ELECTRON body, device_id OVERRIDE ke oauth-url: {oauth_dev[:18]}...")
                        else:
                            # Fallback: replay req_body dari oauth-url
                            rb = dict(oauth_url_captured.get("req_body") or {})
                        rb["code"] = code
                        rb["state"] = ostate  # aosi.*
                        if cb_nav:
                            rb["navigate_uri"] = cb_nav
                        rb["flow_type"] = "web"
                        rb["client_type"] = "web"
                        rb.pop("rid", None)
                        # LEPAS route intercept sebelum exchange
                        try:
                            page.context.unroute("**/google-oauth-login*", on_login_route)
                        except Exception:
                            pass
                        # Extract cookies dari browser context → kirim via urllib (CORS block browser fetch).
                        # 630014 sebelumnya karena urllib TIDAK bawa cookies session.
                        # STRATEGY: exchange via context.request (APIRequestContext) — bawa cookies
                        # browser OTOMATIS (CORS-free, server-side). Fallback ke urllib kalau gagal.
                        # KALAU popup MOBILE context dipakai → exchange dari context itu (IP konsisten).
                        ex_ctx = popup_ctx or page.context
                        try:
                            cookies = ex_ctx.cookies()
                            cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                            print(f"[flow] cookies extracted: {len(cookies)} total, cookie_str len={len(cookie_str)}")
                            print(f"[flow] cookie names: {[c['name'] for c in cookies][:20]}")
                        except Exception as e:
                            cookie_str = ""
                            print(f"[flow] cookie extract gagal: {e}")
                        # Coba exchange via APIRequestContext dulu (bawa cookies & origin browser)
                        try:
                            api_resp = ex_ctx.request.post(
                                "https://autoglm-api.autoglm.ai/userapi/overseasv1/google-oauth-login",
                                data=rb,
                                headers={
                                    "Content-Type": "application/json",
                                    "Accept": "*/*",
                                    "X-Version": "1.12.1",
                                    "X-Tm": "web",
                                    "X-Product": "autoclaw",
                                    "X-Client-Type": "web",
                                    "X-Channel": "official",
                                },
                            )
                            print(f"[flow] context.request status={api_resp.status}")
                            exch = api_resp.json()
                            print(f"[flow] CONTEXT exchange FULL RESPONSE: {_json.dumps(exch)[:600]}")
                            if exch.get("code") == 0 and exch.get("data"):
                                dat = exch["data"]
                                print(f"[flow] CONTEXT EXCHANGE OK — via browser context")
                                rb_fallback = None
                            else:
                                raise RuntimeError(f"context exchange failed code={exch.get('code')}")
                        except Exception as ce:
                            print(f"[flow] context.request exchange skip ({ce}) — fallback urllib+proxy")
                            # exchange WAJIB dari IP yang SAMA dengan oauth-url (SPA DIRECT = VPS).
                            # BUKAN popup_proxy (mobile) — itu cuma utk Google login popup.
                            # stephanie sukses = exchange DIRECT matching oauth-url.
                            exch = exchange_google_oauth_body(rb, cookie_str=cookie_str, proxy_cfg=proxy_cfg)
                        print(f"[flow] exchange FULL RESPONSE: {_json.dumps(exch)[:600]}")
                        print(f"[flow] exchange result code={exch.get('code')} err={exch.get('msg','')[:80]}")
                        if exch.get("code") == 0 and exch.get("data"):
                            dat = exch["data"]
                            dev_real = rb.get("device_id") or device_id
                            tokens = {
                                "status": "ok",
                                "authToken": dat.get("access_token", ""),
                                "refreshToken": dat.get("refresh_token", ""),
                                "email": gmail,
                                "device_id": dev_real,
                                "user_id": dat.get("user_id", ""),
                                "user_name": dat.get("user_name", ""),
                            }
                            if not tokens["authToken"]:
                                tokens["status"] = "failed"
                                tokens["error"] = "access_token kosong di exchange response"
                                return tokens
                            exchanged = True
                            print("[flow] EXCHANGE OK — token diterima, lanjut save")
                            return tokens
                        elif exch.get("error"):
                            print(f"[flow] exchange HTTP error: {exch['error'][:120]}")
                        else:
                            # Code single-use — jangan retry dengan code yang sama
                            break
                time.sleep(1)
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
        env = dict(os.environ)
        # Arahkan DB ke data dir yang sama dengan app VansRouter (DATA_DIR env)
        env.setdefault("DATA_DIR", os.environ.get("VANSROUTER_DATA_DIR", "/home/ubuntu/VansRouter/data"))
        proc = subprocess.run(
            ["node", helper, json.dumps(payload)],
            capture_output=True, text=True, timeout=30, env=env,
            cwd=os.path.join(os.path.dirname(helper), "..", "..", ".."),
        )
        out = proc.stdout.strip()
        print(f"[save] {out[:120]}")
        return out
    except Exception as e:
        print(f"[save] gagal: {e}")
        return None


def register_one(engine, proxy_url, yyds_api_key, yyds_domain, headless, dry_run=False,
                 google_login=False, google_email="", google_password="", invite_code="",
                 exchange_proxy="", google_proxy=""):
    """Register one AutoClaw account. Returns result dict (JSON-line serializable).
    google_proxy: proxy untuk POPUP Google + exchange (IP mobile bersih), terpisah
    dari proxy_url (browser SPA) — hindari Google challenge pada IP VPS/shared."""
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
                # BUG FIX: branch camoufox sebelumnya TIDAK passing proxy → jalan di IP VPS
                # langsung (pasti ke-flag Google/Shumei). Sekarang: proxy + humanize + os.
                cfg = _parse_proxy(proxy_url)
                kws = {"headless": headless, "humanize": True, "os": "windows"}
                if cfg:
                    kws["proxy"] = cfg
                    kws["geoip"] = True  # cegah WebRTC/geolocation bocorkan IP asli
                with Camoufox(**kws) as browser:
                    page = browser.new_page()
                    result = _zai_flow_google(page, google_email, google_password, device_id, invite_code, proxy_cfg=cfg)
            else:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=headless)
                    try:
                        # ignore_https_errors: proxy gateway MITM cert (8081) tidak trusted
                        # untuk autoclaw.z.ai — tanpa ini page.goto ERR_CERT_AUTHORITY_INVALID
                        context = browser.new_context(
                            ignore_https_errors=True,
                            proxy=_parse_proxy(proxy_url),
                        )
                        page = context.new_page()
                        # proxy_cfg di sini = EXCHANGE proxy (browser TANPA proxy biar render cepat)
                        result = _zai_flow_google(page, google_email, google_password, device_id, invite_code, proxy_cfg=_parse_proxy(exchange_proxy), popup_proxy=_parse_proxy(google_proxy))
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
            cfg = _parse_proxy(proxy_url)
            kws = {"headless": headless, "humanize": True, "os": "windows"}
            if cfg:
                kws["proxy"] = cfg
                kws["geoip"] = True  # cegah WebRTC/geolocation bocorkan IP asli
            with Camoufox(**kws) as browser:
                page = browser.new_page()
                return _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            try:
                context = browser.new_context(
                proxy=_parse_proxy(proxy_url),
                ignore_https_errors=True,
            )
                page = context.new_page()
                return _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id)
            finally:
                browser.close()
    except Exception as e:
        return {"status": "failed", "error": str(e), "email": email}


def _zai_flow(page, email, password, device_id, yyds_api_key, yyds_domain, inbox_id):
    """Z.ai signup + Aliyun slider + verify + AutoClaw token extraction on a page."""
    # Load Aliyun captcha lib + signup page (UI register — API endpoint = 405)
    page.goto("https://chat.z.ai/register", wait_until="domcontentloaded", timeout=60000)
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


def _proxy_with_sid(proxy_url, sid):
    """Inject cliproxy-style sid ke proxy gateway (127.0.0.1:8081) untuk rotasi IP per akun.
    Format: http://bulk-sid-<SID>-t-300:x@host:port → gateway pilih egress beda per sid."""
    if not proxy_url or "127.0.0.1:8081" not in proxy_url:
        return proxy_url
    # http://127.0.0.1:8081 → http://bulk-sid-<sid>-t-300:x@127.0.0.1:8081
    return proxy_url.replace("://", f"://bulk-sid-{sid}-t-300:x@", 1)


def _parse_proxy(proxy_url):
    """Parse proxy URL → Playwright context proxy config.
    Chromium --proxy-server flag TIDAK support userinfo (ERR_NO_SUPPORTED_PROXIES),
    jadi userinfo dipisah dan dikirim via context proxy username/password."""
    if not proxy_url:
        return None
    m = re.match(r"^(https?|socks5)://(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)$", proxy_url)
    if not m:
        return {"server": proxy_url}
    scheme, user, pw, host = m.groups()
    cfg = {"server": f"{scheme}://{host}"}
    if user:
        cfg["username"] = user
        cfg["password"] = pw or ""
    return cfg


def main():
    parser = argparse.ArgumentParser(description="AutoClaw bulk registration via Z.ai signup (YYDS temp-mail)")
    parser.add_argument("--count", type=int, default=1, help="number of accounts")
    parser.add_argument("--yyds-api-key", required=True)
    parser.add_argument("--yyds-domain", default="")
    parser.add_argument("--proxy", default="", help="socks5://host:port (browser proxy)")
    parser.add_argument("--exchange-proxy", default="", help="proxy terpisah untuk exchange API (IP maju)");
    parser.add_argument("--google-proxy", default="", help="proxy untuk POPUP Google + exchange (IP mobile bersih, hindari challenge)");
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
    parser.add_argument("--ic", default="", help="invite code (reff chain fission autoclaw)")
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
            sid = f"ac{int(time.time())}{random.randint(1000, 9999)}"
            result = register_one(
                engine=args.engine, proxy_url=_proxy_with_sid(args.proxy, sid),
                exchange_proxy=args.exchange_proxy,
                yyds_api_key=args.yyds_api_key, yyds_domain=args.yyds_domain,
                headless=args.headless, dry_run=args.dry_run,
                google_login=True, google_email=gmail, google_password=gpass,
                invite_code=args.ic,
                google_proxy=args.google_proxy,
            )
            print(json.dumps(result))
            sys.stdout.flush()
        return

    for i in range(args.count):
        sid = f"ac{int(time.time())}{random.randint(1000, 9999)}"
        result = register_one(
            engine=args.engine, proxy_url=_proxy_with_sid(args.proxy, sid),
            yyds_api_key=args.yyds_api_key, yyds_domain=args.yyds_domain,
            headless=args.headless, dry_run=args.dry_run,
            google_login=args.google_login,
            google_email=args.google_email, google_password=args.google_password,
            invite_code=args.ic,
            exchange_proxy=args.exchange_proxy,
            google_proxy=args.google_proxy,
        )
        print(json.dumps(result))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
