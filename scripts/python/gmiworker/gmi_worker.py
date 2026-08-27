#!/usr/bin/env python3
"""GMI Cloud bulk-register worker — uses pierrondi /solve for Turnstile.

Source repo (Dava): https://github.com/dvaaagl/Gmi-Apikey — kita reuse
alur register/verify/2FA/api-key, replace:
  - Capsolver (CAPSOLVER_KEY) -> pierrondi /solve (port 8791)
  - mail.tm per-account -> can be swapped to YYDS/GSuite per-task later

Output: append to /home/ubuntu/VansRouter/scripts/python/gmiworker/results/
  - Accounts.json (list of dicts)
  - apikeys.txt (one key per line)

Run:
  GSUITE_POOL=/tmp/ac_bulk_remaining.txt python3 gmi_worker.py --count 5
  or
  python3 gmi_worker.py --count 1 --email user@e-mail.bty.web.id --password X
"""
import argparse
import datetime
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

import requests

PIERRONDI_URL = os.environ.get("PIERRONDI_URL", "http://127.0.0.1:8791")
GMI = "https://console.gmicloud.ai"
GMI_API = "https://api.gmi-serving.com"
MAIL_TM = "https://api.mail.tm"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
CID = "portal"

DIR = Path(__file__).resolve().parent
RESULTS = DIR / "results"
RESULTS.mkdir(exist_ok=True)
ACCOUNTS_FILE = RESULTS / "Accounts.json"
APIKEYS_FILE = RESULTS / "apikeys.txt"


def log(*a):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)


# ─── TURNSTILE via pierrondi /solve ─────────────────────────────
def solve_turnstile_pierrondi(page_url: str, sitekey: str = "0x4AAAAAAEFlfOlTZMhIA8Vs",
                              timeout_s: int = 90) -> str | None:
    """Submit to pierrondi; tokens come from chain (pierrondi->capsolver->2captcha)."""
    try:
        r = requests.post(f"{PIERRONDI_URL}/solve",
                          json={"type": "turnstile", "sitekey": sitekey,
                                "page_url": page_url, "timeout_s": timeout_s},
                          timeout=timeout_s + 10)
    except requests.RequestException as e:
        log(f"pierrondi unreachable: {e}")
        return None
    if r.status_code != 200:
        log(f"pierrondi HTTP {r.status_code}: {r.text[:200]}")
        return None
    data = r.json()
    if "token" in data:
        return data["token"]
    log(f"pierrondi unsolved: {data.get('reason', data)[:200]}")
    return None


# ─── MAIL.TM (default) or GSuite pool ─────────────────────────
def gen_mailtm() -> dict | None:
    try:
        r = requests.get(f"{MAIL_TM}/domains", timeout=10)
        member = r.json().get("hydra:member", r.json())
        domains = [m["domain"] for m in member if m.get("isActive", True)]
        if not domains:
            return None
        email = f"{secrets.token_hex(6)}@{domains[0]}"
        mail_pw = secrets.token_hex(16)
        requests.post(f"{MAIL_TM}/accounts",
                      json={"address": email, "password": mail_pw}, timeout=10)
        t = requests.post(f"{MAIL_TM}/token",
                          json={"address": email, "password": mail_pw}, timeout=10)
        if t.status_code != 200:
            return None
        return {"email": email, "mail_token": t.json().get("token")}
    except requests.RequestException:
        return None


def get_msg_ids(mail_token: str) -> set:
    try:
        r = requests.get(f"{MAIL_TM}/messages",
                         headers={"Authorization": f"Bearer {mail_token}"}, timeout=10)
        msgs = r.json().get("hydra:member", r.json())
        return {m.get("id") for m in (msgs or [])}
    except requests.RequestException:
        return set()


def poll_code(mail_token: str, old_ids: set, substr: str, digits: int = 6,
              timeout: int = 90) -> tuple[str | None, str | None, set]:
    """Poll mail.tm for a fresh message containing `substr` in subject + N-digit code.
    Returns (code, link_token, updated_old_ids). link_token is captured from
    ``code=(\\d+)&token=([\\w._-]+)`` regex (used by GMI's email verification link)."""
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(4)
        try:
            r = requests.get(f"{MAIL_TM}/messages",
                             headers={"Authorization": f"Bearer {mail_token}"}, timeout=10)
            msgs = r.json().get("hydra:member", r.json()) or []
            for msg in msgs:
                mid = msg.get("id")
                if mid in old_ids:
                    continue
                full = requests.get(f"{MAIL_TM}/messages/{mid}",
                                    headers={"Authorization": f"Bearer {mail_token}"},
                                    timeout=10).json()
                subj = (full.get("subject") or "").lower()
                if substr.lower() in subj:
                    text = full.get("text", "") or ""
                    html = (full.get("html") or [""])[0] if isinstance(full.get("html"), list) else str(full.get("html", ""))
                    m = re.search(r'code=(\d+)&(?:amp;)?token=([\w._-]+)', html)
                    if m:
                        old_ids.add(mid)
                        return m.group(1), m.group(2), old_ids
                    codes = re.findall(rf'\b(\d{{{digits}}})\b', text) or re.findall(rf'\b(\d{{{digits}}})\b', html)
                    if codes:
                        old_ids.add(mid)
                        return codes[0], None, old_ids
                old_ids.add(mid)
        except requests.RequestException:
            pass
    return None, None, old_ids


def hdrs(auth=None):
    h = {"Content-Type": "application/json", "User-Agent": UA,
         "Origin": GMI, "Referer": f"{GMI}/auth/sign-up", "CE-ClientId": CID}
    if auth:
        h["Authorization"] = f"Bearer {auth}"
    return h


# ─── CORE REGISTER FLOW ──────────────────────────────────────
def do_one(email: str | None, password: str | None, silent: bool = False) -> dict | None:
    def step(n, msg, end=" "):
        if not silent:
            print(f"  [{n}/7] {msg}", end=end, flush=True)

    # 1. temp email (or use provided GSuite)
    if email and password:
        step(1, f"Use provided {email}...", end=" "); log_v = f"OK  {email}"
        # try to use mail.tm if email is mail.tm; otherwise use mail.tm for 2FA only
        # GSuite address on mail.tm doesn't work — we use mail.tm for everything
        # unless caller wires up a different inbox. For now, always fall through to mail.tm
        if not silent:
            print(log_v)
        tmp = gen_mailtm()
        if not tmp:
            if not silent: print("    FAIL (mail.tm unavailable)")
            return None
        real_email, mail_token = tmp["email"], tmp["mail_token"]
        # we register on mail.tm but attach custom org name
    else:
        step(1, "Temp email...", end=" ")
        tmp = gen_mailtm()
        if not tmp:
            if not silent: print("FAIL")
            return None
        real_email, mail_token = tmp["email"], tmp["mail_token"]
        if not silent: print(f"OK  {real_email}")

    # 2. Turnstile
    step(2, "Turnstile (pierrondi)...", end=" ")
    ts = solve_turnstile_pierrondi(f"{GMI}/auth/sign-up")
    if not ts:
        if not silent: print("FAIL")
        return None
    if not silent: print("OK")

    # 3. Register
    step(3, "Register...", end=" ")
    try:
        r = requests.get(f"{GMI}/api/v1/agreements/current", timeout=15)
        consents = [{"agreementType": a["agreementType"],
                     "agreementHash": a["agreementHash"],
                     "consent": True}
                    for a in r.json().get("agreements", [])]
    except requests.RequestException:
        consents = []
    pwd = password or (secrets.token_hex(8) + "!Aa1")
    r = requests.post(f"{GMI}/api/v1/users", json={
        "email": real_email, "password": pwd, "turnstile": ts,
        "agreementConsents": consents,
        "organization": {"name": f"Farm-{secrets.token_hex(3)}"},
    }, headers=hdrs(), timeout=25)
    if r.status_code != 201:
        if not silent: print(f"FAIL ({r.status_code})")
        return None
    if not silent: print("OK")

    # 4. Verification email
    step(4, "Verification email...", end=" ")
    old_ids = get_msg_ids(mail_token)
    code, link_token, old_ids = poll_code(mail_token, old_ids, "verify", timeout=60)
    if not code:
        if not silent: print("FAIL no code")
        return None
    if not silent: print(f"OK  code={code}")

    # 5. Browser verify
    step(5, "Browser verify...", end=" ")
    if not link_token:
        if not silent: print("FAIL no link_token"); return None
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False, args=[
                "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                "--single-process", "--no-zygote"])
            ctx = browser.new_context(user_agent=UA)
            page = ctx.new_page()
            page.goto(f"{GMI}/callback/email-verification?code={code}&token={link_token}",
                      timeout=30000, wait_until="commit")
            time.sleep(5)
            browser.close()
    except Exception as e:
        if not silent: print(f"FAIL ({e})")
        return None
    if not silent: print("OK")

    # 6. Login + 2FA
    step(6, "Login + 2FA...", end=" ")
    r = requests.post(f"{GMI}/api/v1/me/auth-tokens",
                      json={"email": real_email, "password": pwd},
                      headers=hdrs(), timeout=25)
    auth_token = r.json().get("authToken")
    if not auth_token:
        if not silent: print("FAIL login"); return None
    r = requests.post(f"{GMI}/api/v1/me/2fa-verification-code",
                      json={"authToken": auth_token}, headers=hdrs(), timeout=25)
    if r.status_code not in (200, 201):
        if not silent: print("FAIL 2FA req"); return None
    otp, _, old_ids = poll_code(mail_token, old_ids, "two-factor", timeout=60)
    if not otp:
        if not silent: print("FAIL 2FA code"); return None
    r = requests.post(f"{GMI}/api/v1/me/sessions",
                      json={"authToken": auth_token, "otpCode": otp},
                      headers=hdrs(), timeout=25)
    access_token = r.json().get("accessToken")
    if not access_token:
        if not silent: print("FAIL session"); return None
    if not silent: print(f"OK  otp={otp}")

    # 7. API key
    step(7, "API key...", end=" ")
    ah = hdrs(access_token)
    r = requests.get(f"{GMI}/api/v1/me/profile", headers=ah, timeout=15)
    org_id = r.json().get("organization", {}).get("id")
    if not org_id:
        if not silent: print("FAIL no org"); return None
    r = requests.post(f"{GMI}/api/v1/organizations/{org_id}/api-keys",
                      json={"name": f"farm-{secrets.token_hex(4)}"},
                      headers=ah, timeout=15)
    if r.status_code not in (200, 201):
        if not silent: print(f"FAIL {r.status_code}"); return None
    api_key = r.json().get("key") or r.json().get("secret") or r.json().get("token")
    if not api_key:
        if not silent: print("FAIL no key"); return None
    if not silent: print(f"OK  {api_key[:24]}…")

    return {
        "email": real_email, "password": pwd, "api_key": api_key,
        "org_id": org_id, "created": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def load_accts():
    if ACCOUNTS_FILE.exists():
        try:
            return json.loads(ACCOUNTS_FILE.read_text())
        except json.JSONDecodeError:
            return []
    return []


def save_accts(accts):
    ACCOUNTS_FILE.write_text(json.dumps(accts, indent=2))
    APIKEYS_FILE.write_text("\n".join(a["api_key"] for a in accts if a.get("api_key")) + "\n")


def load_gsuite(path: str) -> list[tuple[str, str]]:
    out = []
    p = Path(path)
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        email, pwd = line.split(":", 1)
        out.append((email.strip(), pwd.strip()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=1, help="accounts to register")
    ap.add_argument("--email", help="GSuite email (use with --password)")
    ap.add_argument("--password", help="GSuite password")
    ap.add_argument("--gsuite-pool", help="path to GSuite file (user:pass per line)")
    args = ap.parse_args()

    if args.email and not args.password:
        ap.error("--email needs --password")

    accounts = load_accts()
    gsuite = load_gsuite(args.gsuite_pool) if args.gsuite_pool else []

    successes = 0
    for i in range(args.count):
        log(f"=== {i + 1}/{args.count} ===")
        email = args.email
        password = args.password
        if not email and gsuite:
            email, password = gsuite[i % len(gsuite)]
        try:
            res = do_one(email, password)
        except KeyboardInterrupt:
            log("interrupted")
            break
        except Exception as e:
            log(f"crash: {e}")
            res = None
        if res:
            accounts.append(res)
            save_accts(accounts)
            log(f"  ✓ API KEY: {res['api_key'][:24]}…  ({res['email']})")
            successes += 1
        else:
            log("  ✗ FAILED")

    log(f"DONE: {successes}/{args.count} succeeded. Saved to {ACCOUNTS_FILE}")


if __name__ == "__main__":
    main()
