"""llm7reg — LLM7.io bulk signup via YYDS temp mail + Camoufox (Turnstile).

Flow per account:
  1. create YYDS inbox
  2. dash.llm7.io → tick ToS → fill email → "Continue with email"
  3. poll inbox for 6-digit code → fill → Verify (turnstile invisible auto-solve, retry)
  4. dashboard → API Keys → "Add API key" → capture key from body text
  5. emit JSON line {status, email, apiKey}

Usage:
  python3 -m llm7reg --count 1 --yyds-api-key AC-... [--yyds-domain byungu.bond] [--proxy socks5://...]

Output: JSON lines to stdout (one per account), logs to stderr.
Requires: camoufox + yyds_client (PYTHONPATH must include VansRouter/scripts/python).
"""
import argparse
import asyncio
import json
import random
import re
import sys

from yyds_client import yyds_create_owned_inbox, yyds_get_messages

DEFAULT_DOMAIN = "byungu.bond"
VERIFY_ATTEMPTS = 8
CODE_POLL_SECONDS = 60


def _log(msg):
    print(f"[llm7] {msg}", file=sys.stderr, flush=True)


def _suffix(n=5):
    return "".join(random.choices("abcdefghjkmnpqrstuvwxyz23456789", k=n))


async def register_one(yyds_api_key, yyds_domain, proxy=None):
    """Register one llm7 account. Returns dict result."""
    from camoufox.async_api import AsyncCamoufox

    suffix = _suffix()
    addr, jwt = yyds_create_owned_inbox(api_key=yyds_api_key, address_prefix=f"llm7{suffix}")
    _log(f"inbox: {addr}")

    proxy_cfg = {"server": proxy} if proxy else None
    async with AsyncCamoufox(headless=True, proxy=proxy_cfg, geoip=bool(proxy)) as browser:
        page = await browser.new_page()

        try:
            await page.goto("https://dash.llm7.io", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return {"status": "failed", "email": addr, "error": f"goto failed: {str(e)[:120]}"}
        await page.wait_for_timeout(6000)

        # ToS checkbox is a BUTTON[role=checkbox]
        try:
            tos = await page.query_selector('button[role=checkbox]')
            if tos:
                await tos.click()
                await page.wait_for_timeout(1500)
        except Exception as e:
            _log(f"tos click warn: {str(e)[:80]}")

        email_input = await page.query_selector('input[type=email]')
        if not email_input:
            await page.screenshot(path="/tmp/llm7reg_noinput.png")
            return {"status": "failed", "email": addr, "error": "no email input on landing"}
        await email_input.fill(addr)

        submit = await page.query_selector('button:has-text("Continue with email")')
        if not submit:
            return {"status": "failed", "email": addr, "error": "no Continue-with-email button"}
        await submit.click()
        await page.wait_for_timeout(8000)
        _log("[step] email submitted")

        # email-step turnstile may block — retry once after wait
        body = await page.evaluate("document.body.innerText")
        if "security check" in body.lower():
            _log("[step] email step blocked, waiting 15s retry")
            await page.wait_for_timeout(15000)
            submit2 = await page.query_selector('button:has-text("Continue with email")')
            if submit2:
                try:
                    await submit2.click()
                except Exception:
                    pass
            await page.wait_for_timeout(8000)

        # poll code from inbox
        code = None
        for _ in range(max(1, CODE_POLL_SECONDS // 3)):
            await page.wait_for_timeout(3000)
            try:
                msgs = yyds_get_messages(address=addr, token=jwt)
                if msgs:
                    m = msgs[0]
                    codes = re.findall(r"\b(\d{6})\b", str(m.get("text") or "")) or [
                        m.get("verificationCode")
                    ]
                    if codes and codes[0]:
                        code = codes[0]
                        break
            except Exception as e:
                _log(f"poll err: {str(e)[:60]}")
        if not code:
            return {"status": "failed", "email": addr, "error": "no verification code received"}
        _log(f"[step] code: {code}")

        ci = await page.query_selector('input[inputmode=numeric]') or await page.query_selector(
            'input[placeholder*="code" i]'
        )
        if not ci:
            inputs = await page.query_selector_all("input")
            for inp in inputs:
                t = await inp.get_attribute("type")
                if t in ("text", "tel", "number"):
                    ci = inp
                    break
        if not ci:
            return {"status": "failed", "email": addr, "error": "no code input"}
        await ci.fill(code)
        await page.wait_for_timeout(1500)

        # verify — invisible turnstile needs time; keep clicking Verify until pass
        api_key = None
        passed = False
        for attempt in range(VERIFY_ATTEMPTS):
            vb = await page.query_selector('button:has-text("Verify")')
            if vb and await vb.is_visible():
                try:
                    await vb.click()
                except Exception:
                    pass
            await page.wait_for_timeout(10000)
            body = await page.evaluate("document.body.innerText")
            blocked = (
                "Complete the security check" in body
                or "could not load" in body
                or "Sign in to LLM7.io" in body[:40]
            )
            if not blocked:
                passed = True
                _log(f"[step] verified (attempt {attempt})")
                break
            _log(f"[attempt {attempt}] still blocked")

        if not passed:
            await page.screenshot(path="/tmp/llm7reg_verifyfail.png")
            return {"status": "needs_verify", "email": addr, "error": "verify never passed (turnstile)"}

        # dashboard → API Keys → Add API key
        await page.wait_for_timeout(3000)
        try:
            nav = await page.query_selector_all("text=API Keys")
            if nav:
                await nav[0].click()
                await page.wait_for_timeout(4000)
        except Exception as e:
            _log(f"nav warn: {str(e)[:80]}")

        ck = await page.query_selector('button:has-text("Add API key")') or await page.query_selector(
            'button:has-text("Create")'
        )
        if not ck:
            body = await page.evaluate("document.body.innerText.slice(0, 400)")
            return {"status": "needs_manual", "email": addr,
                    "error": f"logged in but no Add-API-key button | {body[:150].replace(chr(10), ' ')}"}

        await ck.click()
        await page.wait_for_timeout(4000)

        # modal may ask a name
        ni = await page.query_selector('input[type=text]:not([hidden])')
        if ni:
            try:
                await ni.fill("vansrouter")
                confirm = await page.query_selector(
                    'button:has-text("Create"), button:has-text("Generate"), button:has-text("Save")'
                )
                if confirm:
                    await confirm.click()
                    await page.wait_for_timeout(4000)
            except Exception as e:
                _log(f"modal name warn: {str(e)[:80]}")

        body = await page.evaluate("document.body.innerText")
        keys = re.findall(r"\b[a-zA-Z0-9_\-]{40,}\b", body)
        if not keys:
            await page.screenshot(path="/tmp/llm7reg_nokey.png")
            return {"status": "needs_manual", "email": addr, "error": "logged in but API key not visible"}

        return {"status": "success", "email": addr, "apiKey": keys[0]}


async def main_async():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--yyds-api-key", required=True)
    ap.add_argument("--yyds-domain", default=DEFAULT_DOMAIN)
    ap.add_argument("--proxy", default=None, help="e.g. socks5://127.0.0.1:40000 (WARP recommended)")
    args = ap.parse_args()

    ok = 0
    for i in range(args.count):
        _log(f"=== account {i + 1}/{args.count} ===")
        try:
            result = await register_one(args.yyds_api_key, args.yyds_domain, args.proxy)
        except Exception as e:
            result = {"status": "failed", "email": "-", "error": str(e)[:200]}
        print(json.dumps(result), flush=True)
        if result.get("status") == "success":
            ok += 1
        # pacing between accounts
        if i < args.count - 1:
            import time
            time.sleep(random.uniform(8, 15))

    _log(f"done: {ok}/{args.count} success")


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
