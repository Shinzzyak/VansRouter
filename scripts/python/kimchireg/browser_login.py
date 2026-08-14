"""browser_login.py — login browser 1x per akun Kimchi, ambil token castai_v1_*.

Kenapa butuh browser: token API key TIDAK bisa didapat full-HTTP dari IP
datacenter (login.kimchi.dev kena Cloudflare Turnstile managed challenge).
Jalankan dari IP residential/bersih (mis. laptop user / VPS dengan proxy
residential) sekali per akun, hasil token di-save ke JSON.

Usage:
  python3 browser_login.py --accounts /tmp/kimchi_batch.json --out /tmp/kimchi_tokens.json
  (buka browser, login manual via UI auth0: email+password dari --accounts)
"""
import argparse
import json
import sys
import time

try:
    from camoufox import Camoufox
except ImportError:
    Camoufox = None

AUTHORIZE_URL = (
    "https://login.kimchi.dev/authorize"
    "?client_id=rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS"
    "&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback"
    "&scope=openid%20profile%20email%20offline_access"
    "&response_type=token"
)


def login_one(browser, account, timeout_s=240):
    email = account["email"]
    page = browser.new_page()
    page.goto(AUTHORIZE_URL, wait_until="domcontentloaded", timeout=60000)
    # Cloudflare challenge — tunggu lolos (manual assist kalau stuck)
    deadline = time.time() + timeout_s
    token = None
    while time.time() < deadline:
        # cek URL berubah ke redirect dengan access_token di fragment
        url = page.url
        if "access_token=" in url:
            import re
            m = re.search(r"access_token=([^&]+)", url)
            if m:
                token = m.group(1)
                break
        # cek halaman login auth0 (form email/password)
        try:
            if page.locator("input[name='username'], input[name='email']").count():
                page.fill("input[name='username'], input[name='email']", email)
                page.fill("input[name='password']", account["password"])
                page.click("button[type='submit'], button:has-text('Continue')")
                # biarkan flow lanjut — kalau ada 2FA/manual, user intervensi
                page.wait_for_timeout(4000)
        except Exception:
            pass
        page.wait_for_timeout(3000)
    page.close()
    return token


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--accounts", required=True, help="JSON dari kimchireg (list dict email/password)")
    ap.add_argument("--out", default="/tmp/kimchi_tokens.json")
    ap.add_argument("--max", type=int, default=5, help="max akun per run")
    args = ap.parse_args()

    if Camoufox is None:
        sys.exit("camoufox tidak terinstall — pakai qoderreg-venv/bin/python")
    with open(args.accounts) as f:
        accounts = [a for a in json.load(f) if a.get("created")]
    accounts = accounts[: args.max]

    results = []
    with Camoufox(headless=False) as browser:
        for i, acc in enumerate(accounts):
            print(f"[{i+1}/{len(accounts)}] {acc['email']} — login...")
            tok = login_one(browser, acc)
            if tok:
                results.append({"email": acc["email"], "password": acc["password"],
                                "token": tok})
                print(f"  TOKEN OK: {tok[:25]}...")
            else:
                print(f"  GAGAL (timeout/block) — skip")
    with open(args.out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDONE: {len(results)}/{len(accounts)} token -> {args.out}")


if __name__ == "__main__":
    main()
