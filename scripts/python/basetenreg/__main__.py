"""basetenreg CLI — register N Baseten accounts, JSON lines on stdout.

Usage:
  python3 -m basetenreg --count 3 --yyds-api-key AC-... [--yyds-domain valerius.biz.id] \\
      [--proxy socks5://host:port] [--headless] [--engine camoufox|chromium]

Per-account output (one JSON line): {"email","password","api_key","status","error"}
Exit 0 if >=1 success, 2 if all failed.

Flow (reconstructed from harvest-console grok-register patch fragments):
browser (Camoufox — Cloudflare JS challenge) → login.baseten.co/sign-up
(name/email/password) → YYDS OTP → magic-code redirect → HTTP continuation with
browser cookies: waiting room submit → approve → onboarding → create API key.
"""
import argparse
import json
import os
import random
import re
import string
import sys
import time

import requests

from ._browser import run_baseten_signup
from ._http import (complete_onboarding, create_api_key, get_user,
                    make_session, submit_waiting_room)
from ._yyds import yyds_create_inbox, yyds_poll_otp

ACCOUNT_TIMEOUT_S = 300


def _err(msg):
    print(msg, file=sys.stderr, flush=True)


def gen_name():
    first = ["Chen", "Li", "Wang", "Zhang", "Liu", "Yang", "Huang", "Zhao",
             "Alex", "Jordan", "Morgan", "Casey", "Riley", "Avery"]
    last = ["Wei", "Jing", "Ming", "Hao", "Fang", "Lin", "Qiang", "Tao",
            "Smith", "Johnson", "Williams", "Brown"]
    return random.choice(first), random.choice(last)


def gen_password():
    return "Bt" + "".join(random.choices(string.ascii_letters + string.digits, k=12)) + "!2"


def register_one(api_key, domain, proxy, headless, engine, index):
    """Register one account. Returns result dict (JSON-serializable)."""
    try:
        # Mailpit first (atherberg.biz.id — lolos blocklist baseten, verified 2026-08-14)
        import random as _r, string as _s, urllib.request as _ur, json as _json, time as _t
        mp_email = None
        try:
            local = "bt" + "".join(_r.choices(_s.ascii_lowercase + _s.digits, k=10))
            mp_email = f"{local}@atherberg.biz.id"
            _err(f"[{index}] mailpit inbox={mp_email}")
        except Exception as _e:
            _err(f"[{index}] mailpit inbox fail ({_e})")

        def _mp_otp():
            if not mp_email:
                return None
            deadline = time.time() + 180
            while time.time() < deadline:
                try:
                    url = f"http://127.0.0.1:8025/api/v1/search?query=to:{mp_email}&limit=5"
                    with _ur.urlopen(url, timeout=10) as resp:
                        data = _json.loads(resp.read().decode("utf-8", "replace"))
                    for msg in data.get("messages", []):
                        tos = [t.get("Address", "") for t in (msg.get("To") or [])]
                        if mp_email not in tos:
                            continue
                        mid = msg.get("ID")
                        body = ""
                        try:
                            with _ur.urlopen(f"http://127.0.0.1:8025/api/v1/message/{mid}", timeout=10) as mr:
                                full = _json.loads(mr.read().decode("utf-8", "replace"))
                            body = (full.get("Subject") or "") + "\n" + (full.get("Text") or "") + "\n" + (full.get("HTML") or "")
                        except Exception:
                            body = msg.get("Snippet", "") or ""
                        m = re.search(r"\b(\d{6})\b", body)
                        if m:
                            return m.group(1)
                    time.sleep(8)
                except Exception:
                    time.sleep(8)
            return None

        # YYDS fallback jika Mailpit tidak tersedia
        inbox_id = None
        if mp_email:
            email = mp_email
        else:
            email, inbox_id = yyds_create_inbox(api_key, domain)
        if not email:
            return {"status": "error", "error": "inbox create failed"}
        first, last = gen_name()
        password = gen_password()
        if not mp_email:
            _err(f"[{index}] inbox={email} name={first} {last}")

        def _otp():
            if mp_email:
                return _mp_otp()
            return yyds_poll_otp(api_key, inbox_id, timeout_s=180)

        cookies = run_baseten_signup(email, password, first, last, proxy, _otp,
                                     engine=engine, headless=headless, log=_err)
        if not cookies:
            return {"status": "error", "error": "browser signup failed (no session)"}

        s = make_session(proxy)
        for c in cookies:
            s.cookies.set(c["name"], c["value"], domain=c.get("domain", ""),
                          path=c.get("path", "/"))

        submit_waiting_room(s, first, last, organization="bt")
        user = get_user(s) or {}
        if (user.get("status") or "") != "APPROVED":
            # Flow 2026-08-14: approval MANUAL via email (waiting room).
            # Akun sudah DIBUAT + session valid — simpan sebagai pending
            # supaya masuk account pool; approval dikirim email baseten.
            return {"status": "pending", "email": email, "password": password,
                    "error": f"waiting approval (status={user.get('status')})"}
        complete_onboarding(s, first, last, organization="bt")
        api = create_api_key(s, name=f"bt-{int(time.time())}")
        if not api:
            return {"status": "error", "error": "approved but no api key"}
        return {"status": "ok", "email": email, "password": password, "api_key": api}
    except Exception as e:
        return {"status": "error", "error": str(e)[:300]}


def main():
    ap = argparse.ArgumentParser(description="Baseten bulk registration")
    ap.add_argument("--count", type=int, default=1, help="number of accounts")
    ap.add_argument("--yyds-api-key", default=os.environ.get("YYDS_API_KEY", ""))
    ap.add_argument("--yyds-domain", default=os.environ.get("YYDS_DOMAIN", "valerius.biz.id"))
    ap.add_argument("--proxy", default=os.environ.get("BASETEN_PROXY", ""),
                    help="socks5://host:port")
    ap.add_argument("--engine", default="camoufox", choices=["camoufox", "chromium"],
                    help="browser engine (camoufox required for Cloudflare)")
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
                              args.headless, args.engine, i)
        result.setdefault("email", "")
        result.setdefault("password", "")
        result.setdefault("api_key", "")
        result.setdefault("error", "")
        if result["status"] == "ok":
            ok += 1
        print(json.dumps(result, ensure_ascii=False), flush=True)
        elapsed = time.time() - started
        _err(f"[{i}] {result['status']} in {elapsed:.0f}s")
        if elapsed < ACCOUNT_TIMEOUT_S:
            time.sleep(min(random.uniform(2, 5), ACCOUNT_TIMEOUT_S - elapsed))

    _err(f"DONE: {ok}/{args.count} accounts")
    return 0 if ok >= 1 else 2


if __name__ == "__main__":
    sys.exit(main())
