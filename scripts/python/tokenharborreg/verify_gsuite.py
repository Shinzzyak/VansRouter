#!/usr/bin/env python3
"""Verify TokenHarbor email via Gmail web (GSuite).

Login Gmail web (Playwright) → cari email dari TokenHarbor → klik link verify.
Usage: verify_gsuite.py <gsuite-email> <gsuite-password> [--timeout 180]
"""
import argparse
import re
import sys
import time

from playwright.sync_api import sync_playwright

GMAIL_URL = "https://mail.google.com"
TH_SENDER = "tokenharbor"  # sender filter di Gmail search


def login_gmail(page, email, password):
    page.goto(GMAIL_URL, timeout=45000)
    time.sleep(2)
    page.fill("input#identifierId", email)
    page.click("#identifierNext")
    time.sleep(3)
    page.fill("input[type=password]", password)
    page.click("#passwordNext")
    time.sleep(8)
    if "mail.google.com" not in page.url:
        raise RuntimeError(f"Gmail login gagal — URL: {page.url[:80]}")
    print(f"[gsuite] login OK {email}")


def find_verify_link(page, timeout_s=180):
    """Cari email TokenHarbor di inbox, buka, extract link verify."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        # search email dari TokenHarbor
        page.goto(f"{GMAIL_URL}/mail/u/0/#search/from%3A{TH_SENDER}", timeout=30000)
        time.sleep(4)
        try:
            rows = page.query_selector_all("tr.zA")
            if rows:
                print(f"[gsuite] email TH ditemukan: {len(rows)} row(s)")
                rows[0].click()
                time.sleep(4)
                # extract link dari body email
                body = page.query_selector("div[role=main]")
                if body:
                    html = body.inner_html()
                    # cari link verify (tokenharbor.ai/verify atau /api/verify)
                    m = re.search(r'https://tokenharbor\.ai[^"\s<>]*verify[^"\s<>]*', html)
                    if not m:
                        m = re.search(r'https?://[^"\s<>]*tokenharbor[^"\s<>]*', html)
                    if m:
                        link = m.group(0).replace("&amp;", "&")
                        print(f"[gsuite] verify link: {link[:80]}...")
                        return link
                    print("[gsuite] email TH terbuka tapi link verify tidak ketemu")
        except Exception as e:
            print(f"[gsuite] scan error: {e}")
        time.sleep(10)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("password")
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context()
        page = ctx.new_page()
        try:
            login_gmail(page, args.email, args.password)
            link = find_verify_link(page, args.timeout)
            if not link:
                print(json_dump({"status": "no_link", "email": args.email}))
                sys.exit(1)
            # buka link verify
            page.goto(link, timeout=30000)
            time.sleep(5)
            print(json_dump({"status": "verify_opened", "email": args.email, "url": page.url[:80]}))
        finally:
            b.close()


def json_dump(d):
    import json
    return json.dumps(d, ensure_ascii=False)


if __name__ == "__main__":
    main()
