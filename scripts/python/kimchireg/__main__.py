"""kimchireg — bulk register akun Kimchi (CAST AI) via Auth0 signup API.

Flow (ditemukan subagent riset 2026-08-14):
1. POST https://login.kimchi.dev/dbconnections/signup
   {client_id, email, password, connection: "Username-Password-Authentication"}
   → akun dibuat, NO captcha, NO email verify.
2. Token API key `castai_v1_*` TIDAK bisa didapat full-HTTP dari IP datacenter
   (login flow kena Cloudflare Turnstile). Butuh 1x browser login dari IP
   bersih/residential per akun → ambil token dari cli-auth callback.
   Script ini: signup API massal (langkah 1), lalu print daftar akun untuk
   batch login browser (langkah 2) — lihat kimchireg/browser_login.py.

Validasi akun: GET https://api.cast.ai/v1/llm/openai/supported-providers
dengan Bearer key → 200 = valid.
"""
import argparse
import json
import random
import string
import sys
import time
import urllib.error
import urllib.request

CLIENT_ID = "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS"
SIGNUP_URL = "https://login.kimchi.dev/dbconnections/signup"
ME_URL = "https://app.kimchi.dev/api/v1/me"
PROVIDERS_URL = "https://api.cast.ai/v1/llm/openai/supported-providers"


def gen_password():
    return "Kc" + "".join(random.choices(string.ascii_letters + string.digits, k=14)) + "!"


def signup_one(email, password):
    body = json.dumps({
        "client_id": CLIENT_ID,
        "email": email,
        "password": password,
        "connection": "Username-Password-Authentication",
    }).encode()
    req = urllib.request.Request(SIGNUP_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Origin": "https://login.kimchi.dev",
                                          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode())
            return j, r.status
    except urllib.error.HTTPError as e:
        try:
            j = json.loads(e.read().decode())
        except Exception:
            j = {}
        return j, e.code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--count", type=int, default=1)
    ap.add_argument("--prefix", default="kc")
    ap.add_argument("--domain", default="gmail.com")
    ap.add_argument("--out", default="/tmp/kimchi_accounts.json")
    args = ap.parse_args()

    results = []
    for i in range(args.count):
        local = args.prefix + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
        email = f"{local}@{args.domain}"
        pw = gen_password()
        j, status = signup_one(email, pw)
        ok = status == 200 and j.get("_id")
        results.append({"email": email, "password": pw, "status": status,
                        "created": bool(ok), "id": j.get("_id", ""),
                        "email_verified": j.get("email_verified", False)})
        print(f"[{i+1}/{args.count}] {email} -> {status} created={bool(ok)} id={j.get('_id','')[:12]}")
        time.sleep(1.5)  # pacing

    with open(args.out, "w") as f:
        json.dump(results, f, indent=2)
    ok_n = sum(1 for r in results if r["created"])
    print(f"\nDONE: {ok_n}/{args.count} created -> {args.out}")
    if ok_n:
        print("NEXT: login browser 1x per akun dari IP residential utk ambil token (lihat kimchireg/browser_login.py)")


if __name__ == "__main__":
    main()
