#!/usr/bin/env python3
"""
Webshare Proxy Farm — auto-register akun Webshare + ambil proxy per akun.

Pipeline:
  1. Create email via YYDS API (maliapi.215.im)
  2. Solve reCAPTCHA v2 via local captcha-solver sidecar (port 8877)
  3. POST register ke proxy.webshare.io/api/v2/register/
  4. GET proxy list dari API
  5. Append ke webshare_proxies.txt

Env required:
  YYDS_API_KEY  — API key untuk YYDS mail (AC-...)
  CAPTCHA_PORT  — port captcha solver (default 8877)

Usage:
  python3 webshare_farm.py [--count 3] [--output webshare_proxies.txt] [--dry-run]
"""
import json
import os
import sys
import time
import random
import argparse
import requests

# ── config ────────────────────────────────────────────────────────────────────
# Default working key (proven 2026-08-18)
_DEFAULT_YYDS_KEY = "AC-e776a410e773b73824482139"

# Load .env files for API keys (only if env var not already set)
for _env_path in [
    "/home/ubuntu/projects/router-harvest-console/.env",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"),
    os.path.expanduser("~/.env"),
]:
    if os.path.exists(_env_path) and "YYDS_API_KEY" not in os.environ:
        for _line in open(_env_path):
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                _k = _k.strip()
                _v = _v.strip().strip("'\"")
                if _k not in os.environ:
                    os.environ[_k] = _v
        break

YYDS_BASE = os.environ.get("YYDS_BASE", "https://maliapi.215.im/v1")
YYDS_KEY = os.environ.get("YYDS_API_KEY", _DEFAULT_YYDS_KEY).strip().strip("'\"")
YYDS_DOMAIN = os.environ.get("YYDS_DOMAIN", "valerius.biz.id")
CAPTCHA_SOLVER = os.environ.get("CAPTCHA_SOLVER", "http://127.0.0.1:8877")
RECAPTCHA_SITEKEY = "6LeHZ6UUAAAAAKat_YS--O2tj_by3gv3r_l03j9d"
REGISTER_URL = "https://proxy.webshare.io/api/v2/register/"
PROXY_LIST_URL = "https://proxy.webshare.io/api/v2/proxy/list/"
FIXED_PASSWORD = "Pasardigital#26"
OUTPUT_FILE = "/home/ubuntu/VansRouter/scripts/python/websharereg/webshare_proxies.txt"

# ── helpers ───────────────────────────────────────────────────────────────────
def _req(url, data=None, headers=None, method=None, timeout=15):
    """HTTP requester using requests library."""
    hdrs = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    if headers:
        hdrs.update(headers)
    try:
        if data is not None:
            r = requests.post(url, json=data, headers=hdrs, timeout=timeout)
        else:
            r = requests.get(url, headers=hdrs, timeout=timeout)
        return r.status_code, r.json() if r.content else {}
    except requests.HTTPError as e:
        return e.response.status_code, str(e.response.text)[:300]
    except Exception as e:
        return 0, str(e)[:200]


def create_yyds_email():
    """Create new inbox via YYDS API. Returns (email, inbox_id) or (None, None)."""
    if not YYDS_KEY:
        print("  WARN: YYDS_API_KEY not set")
        return None, None
    headers = {"Authorization": f"Bearer {YYDS_KEY}"}
    # Try /inboxes endpoint
    status, body = _req(f"{YYDS_BASE}/inboxes", data={"domain": YYDS_DOMAIN}, headers=headers)
    if status == 201 and isinstance(body, dict):
        inbox = body.get("data") or body
        email = inbox.get("address") or inbox.get("email") or inbox.get("id")
        iid = inbox.get("id")
        if email:
            return email, iid
    # Try /accounts endpoint
    status, body = _req(f"{YYDS_BASE}/accounts", data={"domain": YYDS_DOMAIN}, headers=headers)
    if status == 201 and isinstance(body, dict):
        inbox = body.get("data") or body
        email = inbox.get("address") or inbox.get("email")
        iid = inbox.get("id")
        if email:
            return email, iid
    print(f"  YYDS create failed: status={status} body={str(body)[:150]}")
    return None, None


def poll_yyds_messages(email, iid, timeout_s=60, interval_s=2):
    """Poll inbox for messages. Returns list of messages."""
    if not YYDS_KEY:
        return []
    headers = {"Authorization": f"Bearer {YYDS_KEY}"}
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        path = f"{YYDS_BASE}/inboxes/{iid}/messages" if iid else f"{YYDS_BASE}/messages?address={email}"
        status, body = _req(path, headers=headers)
        if status == 200 and isinstance(body, dict):
            msgs = (body.get("data") or {}).get("messages") or body.get("messages") or []
            if msgs:
                return msgs
        time.sleep(interval_s)
    return []


def solve_recaptcha(url, timeout_s=120):
    """Solve reCAPTCHA v2 via local captcha-solver sidecar. Returns token or None."""
    payload = {
        "type": "recaptcha",
        "version": "invisible",
        "enterprise": False,
        "real_page": True,
        "sitekey": RECAPTCHA_SITEKEY,
        "url": url,
        "timeout_s": timeout_s,
        "classifier": "yolo",
    }
    status, body = _req(CAPTCHA_SOLVER + "/solve", data=payload, timeout=timeout_s + 10)
    if status == 200 and isinstance(body, dict):
        token = body.get("token") or body.get("solved_token") or body.get("recaptcha_token")
        if token:
            print(f"    Captcha solved: token len={len(token)}")
            return token
        if body.get("solved"):
            return body.get("token")
    print(f"    Captcha solve failed: status={status} body={str(body)[:200]}")
    return None


def register_webshare(email, recaptcha_token):
    """POST register to Webshare API. Returns (success, response_dict)."""
    payload = {
        "email": email,
        "password": FIXED_PASSWORD,
        "recaptcha": recaptcha_token,
        "tos_accepted": True,
        "marketing_email_accepted": False,
    }
    headers = {
        "Origin": "https://proxy.webshare.io",
        "Referer": "https://proxy.webshare.io/register",
    }
    status, body = _req(REGISTER_URL, data=payload, headers=headers)
    if status == 200 and isinstance(body, dict):
        if "token" in body:
            return True, body
        errors = []
        for key, val in body.items():
            if isinstance(val, list):
                errors.extend(val)
        if errors:
            return False, {"errors": errors}
        return False, body
    if status == 400:
        return False, {"http_error": status, "body": body}
    return False, {"http_error": status, "body": body}


def fetch_proxies(api_token, page_size=25):
    """GET proxy list from Webshare API. Returns list of proxy strings."""
    headers = {"Authorization": f"Token {api_token}"}
    proxies = []
    page = 1
    while True:
        url = f"{PROXY_LIST_URL}?mode=direct&page={page}&page_size={page_size}"
        status, body = _req(url, headers=headers)
        if status != 200 or not isinstance(body, dict):
            print(f"    Fetch proxies page {page} failed: status={status}")
            break
        results = body.get("results") or body.get("data") or []
        if not results:
            break
        for p in results:
            host = p.get("proxy_address", "")
            port = p.get("port", "")
            user = p.get("username", "")
            pw = p.get("password", "")
            if host and port and user and pw:
                proxies.append(f"{host}:{port}:{user}:{pw}")
        if len(results) < page_size:
            break
        page += 1
        time.sleep(0.5)
    return proxies


def append_proxies(proxies, output_file):
    """Append proxies to output file. Returns (appended_count, total_count)."""
    existing = []
    if os.path.exists(output_file):
        for line in open(output_file):
            line = line.strip()
            if line and not line.startswith("#") and line.count(":") >= 3:
                existing.append(line)
    with open(output_file, "a") as f:
        if existing:
            f.write("\n")
        f.write(f"\n# Generated {time.strftime('%Y-%m-%d %H:%M')} by webshare_farm.py\n")
        for p in proxies:
            f.write(p + "\n")
    return len(proxies), len(existing) + len(proxies)


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Webshare Proxy Farm")
    ap.add_argument("--count", type=int, default=3, help="number of accounts to create (default 3)")
    ap.add_argument("--output", default=OUTPUT_FILE)
    ap.add_argument("--dry-run", action="store_true", help="don't actually register")
    args = ap.parse_args()

    # Check prerequisites
    if not YYDS_KEY:
        print("ERROR: YYDS_API_KEY environment variable not set")
        sys.exit(1)

    # Check captcha solver
    status, _ = _req(CAPTCHA_SOLVER + "/health")
    if status != 200:
        print(f"ERROR: Captcha solver not available at {CAPTCHA_SOLVER}")
        print("  Start it with: cd /home/ubuntu/research/captcha-solver && .venv/bin/python server.py")
        sys.exit(1)
    print(f"Captcha solver: OK ({CAPTCHA_SOLVER})")
    print(f"YYDS API key: {YYDS_KEY[:8]}... (len={len(YYDS_KEY)})")
    print(f"YYDS domain: {YYDS_DOMAIN}")

    # Load existing proxies
    existing = []
    if os.path.exists(args.output):
        for line in open(args.output):
            line = line.strip()
            if line and not line.startswith("#") and line.count(":") >= 3:
                existing.append(line)
    print(f"Existing proxies in {args.output}: {len(existing)}")

    results = []
    total_proxies = 0
    success_count = 0

    for i in range(1, args.count + 1):
        print(f"\n=== Account {i}/{args.count} ===")

        # 1. Create email
        email, iid = create_yyds_email()
        if not email:
            print(f"  FAIL: could not create email")
            results.append({"account": i, "status": "email_fail"})
            continue
        print(f"  Email: {email} (iid={iid})")

        # 2. Solve reCAPTCHA
        captcha_token = solve_recaptcha("https://proxy.webshare.io/register", timeout_s=120)
        if not captcha_token:
            print(f"  SKIP: could not solve captcha")
            results.append({"account": i, "email": email, "status": "captcha_fail"})
            continue

        # 3. Register
        if args.dry_run:
            print(f"  [DRY RUN] skip register")
            results.append({"account": i, "email": email, "status": "dry_run"})
            continue

        ok, reg_resp = register_webshare(email, captcha_token)
        if ok and "token" in reg_resp:
            api_token = reg_resp["token"]
            print(f"  REGISTERED: {email} → token={api_token[:20]}...")

            # 4. Fetch proxies
            proxies = fetch_proxies(api_token)
            if proxies:
                print(f"  PROXIES: {len(proxies)} fetched")
                total_proxies += len(proxies)
                success_count += 1
                results.append({
                    "account": i,
                    "email": email,
                    "token": api_token,
                    "proxies_count": len(proxies),
                    "status": "ok"
                })
            else:
                print(f"  NO PROXIES: account created but no proxies returned")
                results.append({"account": i, "email": email, "status": "no_proxies"})
        else:
            print(f"  REGISTER failed: {json.dumps(reg_resp)[:200]}")
            results.append({"account": i, "email": email, "status": "register_fail", "response": str(reg_resp)[:100]})

        # Rate limiting
        time.sleep(random.uniform(2, 5))

    # 5. Save proxies
    all_proxies = []
    for r in results:
        if r.get("status") == "ok":
            proxies = fetch_proxies(r["token"])
            all_proxies.extend(proxies)

    if all_proxies:
        appended, total = append_proxies(all_proxies, args.output)
        print(f"\nSaved {appended} new proxies to {args.output} (total now: {total})")
    else:
        print(f"\nNo proxies to save")

    # Summary
    print(f"\n{'='*50}")
    print(f"SUMMARY")
    print(f"  Accounts attempted: {args.count}")
    print(f"  Accounts successful: {success_count}")
    print(f"  Total proxies fetched: {total_proxies}")
    print(f"  Results: {json.dumps(results, indent=2)}")

    # Save results JSON
    results_path = "/tmp/webshare_farm_results.json"
    with open(results_path, "w") as f:
        json.dump({
            "attempted": args.count,
            "success": success_count,
            "proxies_total": total_proxies,
            "results": results
        }, f, indent=2)
    print(f"Results saved to {results_path}")


if __name__ == "__main__":
    main()
