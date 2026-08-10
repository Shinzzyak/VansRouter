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
except ImportError:  # allow running as standalone script
    from qoderreg._yyds import yyds_create_inbox, yyds_poll_otp
    from qoderreg._slider import solve_slider_v2


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


def register_one(engine, proxy_url, yyds_api_key, yyds_domain, headless, dry_run=False):
    """Register one AutoClaw account. Returns result dict (JSON-line serializable)."""
    email = None
    inbox_id = None
    try:
        if dry_run:
            email = f"test-{uuid.uuid4().hex[:8]}@yyds.dev"
            return {"status": "dry_run", "email": email,
                    "note": "signup would POST /auths/signup with Aliyun slider"}

        # 1. YYDS inbox
        inbox = yyds_create_inbox(yyds_api_key, yyds_domain)
        email = inbox["email"]
        inbox_id = inbox.get("id")
        password = gen_password()
        device_id = random_device_id()

        # 2. Browser flow: signup + Aliyun slider + verify + AutoClaw login
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser_args = []
            if proxy_url:
                browser_args.append(f"--proxy-server={proxy_url}")
            browser = p.chromium.launch(headless=headless, args=browser_args)
            context = browser.new_context()
            page = context.new_page()

            # Load Aliyun captcha lib + signup page
            page.goto(f"{ZAI_API}/auths/signup", wait_until="domcontentloaded")
            page.add_script_tag(url=ALIYUN_CAPTCHA_JS)

            # Solve Aliyun slider if present
            captcha_param = solve_slider_v2(page)
            if not captcha_param:
                browser.close()
                return {"status": "failed", "error": "captcha solve failed", "email": email}

            ok, data = signup_zai_http(email, password, device_id, captcha_param)
            if not ok:
                browser.close()
                return {"status": "failed", "error": str(data.get("detail") or data), "email": email}

            # 3. Verify email — wait for YYDS inbox code
            token = wait_for_verify_token(yyds_api_key, yyds_domain, inbox_id, email)
            if not token:
                browser.close()
                return {"status": "failed", "error": "verify email token not received", "email": email}

            # 4. Signin + AutoClaw
            page.goto(AUTOCLAW_WEB_URL, wait_until="domcontentloaded")
            page.evaluate(f"""() => {{
              localStorage.setItem('autoclaw.web.authToken', '{data.get('token') or ''}');
              localStorage.setItem('autoclaw.web.refreshToken', '{data.get('refresh_token') or ''}');
              localStorage.setItem('autoclaw.web.deviceId', '{device_id}');
            }}""")
            tokens = extract_autoclaw_tokens(page)

            browser.close()
            return {
                "status": "ok",
                "email": email,
                "access_token": tokens.get("authToken") or data.get("token") or "",
                "refresh_token": tokens.get("refreshToken") or data.get("refresh_token") or "",
                "device_id": tokens.get("deviceId") or device_id,
                "user_id": tokens.get("userId"),
                "user_name": tokens.get("userName"),
            }
    except Exception as e:
        return {"status": "failed", "error": str(e), "email": email}


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


def wait_for_verify_token(yyds_api_key, yyds_domain, inbox_id, email, timeout_s=180):
    """Poll YYDS inbox for the Z.ai verification link/token."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        code = yyds_poll_otp(yyds_api_key, inbox_id)
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
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="print plan only, no signup")
    args = parser.parse_args()

    for i in range(args.count):
        result = register_one(
            engine=args.engine, proxy_url=args.proxy,
            yyds_api_key=args.yyds_api_key, yyds_domain=args.yyds_domain,
            headless=args.headless, dry_run=args.dry_run,
        )
        print(json.dumps(result))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
