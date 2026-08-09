"""qoderreg CLI — register N Qoder accounts, JSON lines on stdout.

Usage:
  python3 -m qoderreg --count 3 --yyds-api-key KEY [--yyds-domain valerius.biz.id] \\
      [--proxy socks5://host:port] [--headless] [--engine chromium]

Per-account output (one JSON line): {"email","password","token","status","error"}
Exit 0 if >=1 success, 2 if all failed.
"""
import argparse
import base64
import hashlib
import json
import os
import random
import string
import sys
import threading
import time
import uuid

import requests

from ._browser import run_browser_flow
from ._yyds import yyds_create_inbox, yyds_poll_otp
from ._driftz import driftz_create_inbox, driftz_poll_otp
from ._tempik import tempik_create_inbox, tempik_poll_otp
DEVICE_URL = "https://qoder.com/device/selectAccounts"
POLL_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll"
CLIENT_ID_WEB = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb"

_ACCOUNT_TIMEOUT_S = 300


def _err(msg, **kwargs):
    print(msg, file=sys.stderr, flush=True)


def pkce_pair():
    verifier = base64.urlsafe_b64encode(os.urandom(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def device_auth_url(challenge, client_id=CLIENT_ID_WEB):
    nonce = str(uuid.uuid4())
    machine_id = hashlib.md5(os.urandom(16)).hexdigest()
    return (f"{DEVICE_URL}?challenge={challenge}&challenge_method=S256"
            f"&nonce={nonce}&machine_id={machine_id}&client_id={client_id}"), nonce


def poll_device_token(nonce, verifier, timeout_s=120, interval=5):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            r = requests.get(POLL_URL, params={
                "nonce": nonce, "verifier": verifier, "challenge_method": "S256",
            }, timeout=20)
            j = r.json()
            if j.get("token"):
                return j["token"]
            if j.get("errorCode") and j["errorCode"] != "NotFound":
                return None
        except Exception:
            pass
        time.sleep(interval)
    return None


def gen_name():
    first = ["Chen", "Li", "Wang", "Zhang", "Liu", "Yang", "Huang", "Zhao",
             "Alex", "Jordan", "Morgan", "Casey", "Riley", "Avery"]
    last = ["Wei", "Jing", "Ming", "Hao", "Fang", "Lin", "Qiang", "Tao",
            "Smith", "Johnson", "Williams", "Brown"]
    return random.choice(first), random.choice(last)


def gen_password():
    return "Qd" + "".join(random.choices(string.ascii_letters + string.digits, k=10)) + "!2"


def _create_inbox_chain(api_key, domain):
    """YYDS → Driftz → tempik. Returns (email, inbox_id) or (None, None)."""
    if api_key:
        try:
            inbox = yyds_create_inbox(api_key, domain)
            if inbox:
                return inbox
        except Exception as e:
            _err(f"[mail] YYDS failed ({e}) → driftz fallback")
    try:
        inbox = driftz_create_inbox()
        if inbox:
            return inbox
    except Exception as e:
        _err(f"[mail] driftz failed ({e}) → tempik fallback")
    try:
        return tempik_create_inbox()
    except Exception as e:
        _err(f"[mail] tempik failed ({e})")
        return None, None


def _poll_otp_chain(api_key, email, inbox_id):
    """YYDS → Driftz → tempik OTP poll. Returns 6-digit code or None."""
    if api_key and inbox_id:
        try:
            c = yyds_poll_otp(api_key, inbox_id, timeout_s=180)
            if c:
                return c
        except Exception:
            pass
    try:
        c = driftz_poll_otp(email, timeout_s=240)
        if c:
            return c
    except Exception:
        pass
    try:
        return tempik_poll_otp(email, timeout_s=240, session_id=inbox_id)
    except Exception:
        return None


def register_one(api_key, domain, proxy, headless, index):
    """Register one account. Returns result dict (JSON-serializable)."""
    try:
        inbox = _create_inbox_chain(api_key, domain)
        if not inbox[0]:
            return {"status": "error", "error": "inbox create failed (yyds/driftz/tempik)"}
        email, inbox_id = inbox
        first, last = gen_name()
        password = gen_password()
        _err(f"[{index}] inbox={email} name={first} {last}")

        verifier, challenge = pkce_pair()
        auth_url, nonce = device_auth_url(challenge)

        # poll device token in parallel with browser flow
        poll_box = {}

        def _poll():
            poll_box["token"] = poll_device_token(
                nonce, verifier, timeout_s=240, interval=2)

        t = threading.Thread(target=_poll, daemon=True)
        t.start()

        def _otp():
            return _poll_otp_chain(api_key, email, inbox_id)

        try:
            run_browser_flow(email, password, first, last, proxy, auth_url, _otp,
                             headless=headless, log=_err)
        except Exception as e:
            _err(f"[{index}] browser flow failed: {e}")
        t.join(timeout=260)
        token = poll_box.get("token")
        if not token:
            token = poll_device_token(nonce, verifier, timeout_s=60)
        if not token:
            return {"status": "error", "error": "no device token"}
        return {"status": "ok", "email": email, "password": password, "token": token}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def main():
    ap = argparse.ArgumentParser(description="Qoder bulk registration (chromium-only)")
    ap.add_argument("--count", type=int, default=1, help="number of accounts")
    ap.add_argument("--yyds-api-key", default=os.environ.get("YYDS_API_KEY", ""))
    ap.add_argument("--yyds-domain", default=os.environ.get("YYDS_DOMAIN", "valerius.biz.id"))
    ap.add_argument("--proxy", default=os.environ.get("QODER_PROXY", ""),
                    help="socks5://host:port")
    ap.add_argument("--engine", default="chromium", choices=["chromium"],
                    help="browser engine (chromium only)")
    ap.add_argument("--headless", action="store_true", default=True,
                    help="run headless (default)")
    args = ap.parse_args()

    if not args.yyds_api_key:
        _err("FATAL: YYDS_API_KEY missing (--yyds-api-key or env)")
        return 2
    if args.count < 1:
        _err("FATAL: --count must be >= 1")
        return 2

    ok = 0
    for i in range(1, args.count + 1):
        started = time.time()
        result = register_one(args.yyds_api_key, args.yyds_domain, args.proxy,
                              args.headless, i)
        result.setdefault("email", "")
        result.setdefault("password", "")
        result.setdefault("token", "")
        result.setdefault("error", "")
        if result["status"] == "ok":
            ok += 1
        print(json.dumps(result, ensure_ascii=False), flush=True)
        elapsed = time.time() - started
        _err(f"[{i}] {result['status']} in {elapsed:.0f}s")
        if elapsed < _ACCOUNT_TIMEOUT_S:
            time.sleep(min(random.uniform(2, 5), _ACCOUNT_TIMEOUT_S - elapsed))

    _err(f"DONE: {ok}/{args.count} accounts")
    return 0 if ok >= 1 else 2


if __name__ == "__main__":
    sys.exit(main())
