#!/usr/bin/env python3
"""ZCode / Z.ai OAuth CLI flow authenticated with our GSuite Google accounts.

Newest mechanism (2026-08/09), no stored cookies required:
  1) POST zcode.z.ai/api/v1/oauth/cli/init  (Bearer <32-byte hex>) -> flow_id + authorize_url
  2) authorize_url lands on chat.z.ai/auth -> "Continue with Google"
  3) Google identifier + password (GSuite e-mail.bty.web.id) -> consent
  4) ZCode consent page -> tick ToS checkbox -> Continue
  5) GET .../cli/poll/<flow_id> until status=ready -> token (JWT) + zai.access_token
  6) write zcodeJwtToken / zaiAccessToken / zcodeJwtSavedAt into providerConnections

Everything is routed through WARP (socks5h://127.0.0.1:40000) because z.ai
rate-limits/blocks the datacenter IP directly.

Usage:
  python3 zcode_cli_oauth_gsuite.py --email sarah.johnson@e-mail.bty.web.id --no-backup
  python3 zcode_cli_oauth_gsuite.py --limit 3 --lock
  python3 zcode_cli_oauth_gsuite.py --all --lock          # every account in the list
"""
import argparse
import json
import os
import secrets
import shutil
import sqlite3
import sys
import time

import requests

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
ACCOUNTS_FILE = "/home/ubuntu/pelerproxy/gsuite-accounts.txt"
WARP = "socks5h://127.0.0.1:40000"
LOCK_PATH = "/tmp/zcode-oauth-gsuite.lock"
BACKUP_DIR = "/tmp/zcode-refresh-backups"
RESULT_PATH = "/tmp/zcode_gsuite_oauth_result.json"
PROGRESS_PATH = "/tmp/zcode_gsuite_progress.txt"
MIN_AVAIL_MB = 700
INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init"
POLL_URL = "https://zcode.z.ai/api/v1/oauth/cli/poll"


def mem_avail_mb():
    with open("/proc/meminfo") as fh:
        for line in fh:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 9999


def load_accounts():
    out = {}
    with open(ACCOUNTS_FILE, errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line or ":" not in line:
                continue
            email, pw = line.split(":", 1)
            out[email.strip().lower()] = pw.strip()
    return out


def already_fresh(email, hours=24):
    conn = sqlite3.connect(DB)
    try:
        row = conn.execute(
            "SELECT data FROM providerConnections WHERE provider='zcode' AND lower(email)=?",
            (email.lower(),),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return False, "no-db-row"
    try:
        psd = (json.loads(row[0]) or {}).get("providerSpecificData") or {}
    except Exception:
        return False, "bad-json"
    saved = psd.get("zcodeJwtSavedAt")
    if not psd.get("zcodeJwtToken") or not saved:
        return False, "no-jwt"
    try:
        saved_ts = time.mktime(time.strptime(saved[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return False, "bad-ts"
    age_h = (time.time() - saved_ts) / 3600
    return (age_h < hours), f"age={age_h:.1f}h"


def init_flow():
    poll_token = secrets.token_hex(32)
    r = requests.post(
        INIT_URL,
        json={"provider": "zai"},
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {poll_token}"},
        proxies={"https": WARP, "http": WARP},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()["data"]
    return poll_token, data["flow_id"], data["authorize_url"]


def poll_flow(poll_token, flow_id, tries=40, interval=2):
    url = f"{POLL_URL}/{flow_id}"
    for _ in range(tries):
        try:
            r = requests.get(
                url,
                headers={"Authorization": f"Bearer {poll_token}"},
                proxies={"https": WARP, "http": WARP},
                timeout=20,
            )
            if r.status_code == 404:
                return None
            body = r.json()
            status = (body.get("data") or {}).get("status", "?")
            if status != "pending":
                return body
        except Exception:
            pass
        time.sleep(interval)
    return None


def _click_text(page, patterns):
    """Click the first visible button/link whose text matches any regex."""
    return page.evaluate(
        """(pats) => {
        const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
        const els = [...document.querySelectorAll('button,[role=button],a,div[role=button]')].filter(vis);
        for (const p of pats) {
            const re = new RegExp(p, 'i');
            const el = els.find(e => re.test((e.innerText||'').replace(/\\s+/g,' ').trim()));
            if (el) { el.click(); return (el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50); }
        }
        return null;
    }""",
        patterns,
    )


def _click_google(page):
    """chat.z.ai's Google entry point is a button whose inner text is split
    across spans (the debug dump reads `Continue | with | Google`), so a plain
    text match on the whole button misses it as often as not. Two selectors are
    tried, and the whole click is retried because the button sometimes renders
    late behind the initial paint.

    Empirically (camoufox headless via WARP) the click NAVIGATES THE SAME TAB to
    accounts.google.com — it does not open a popup. Wrapping the click in
    expect_popup therefore only burns its timeout after the page has already
    left chat.z.ai.
    """
    cands = [
        "button.ButtonContinueWithGoogle",
        ".ButtonContinueWithGoogle",
        "button:has-text('Continue with Google')",
    ]
    last = "none"
    clicked = False
    # The auth page paints its login options only after hydration, and on a cold
    # profile that can take a while — wait for a clickable control before trying.
    for _ in range(8):
        try:
            ready = page.evaluate(
                """() => !!document.querySelector(
                'button.ButtonContinueWithGoogle, .ButtonContinueWithGoogle,'
                + 'button,a,div[role=button]')"""
            )
        except Exception:
            ready = False
        if ready:
            break
        try:
            page.wait_for_timeout(3000)
        except Exception:
            time.sleep(3)

    for attempt in range(4):
        # chat.z.ai serves more than one markup variant for this button: some
        # renders carry ButtonContinueWithGoogle, others a plain
        # `button-gradient` class with the label split across spans. A
        # whitespace-normalised text match covers both, so it runs first.
        try:
            hit = page.evaluate(
                """() => {
                const want = 'continue with google';
                for (const b of document.querySelectorAll('button,a,div[role=button]')) {
                    const t = (b.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    if (t === want) { b.setAttribute('data-zc-google', '1'); return t; }
                }
                return null;
            }"""
            )
            if hit:
                page.click("[data-zc-google='1']", timeout=8000)
                last = "text-normalized"
                clicked = True
                break
        except Exception:
            pass
        for sel in cands:
            try:
                page.wait_for_selector(sel, timeout=12000)
            except Exception:
                continue
            try:
                page.click(sel, timeout=8000)
                last = sel
                clicked = True
                break
            except Exception:
                # something (overlay, animation) is eating the click — force it
                try:
                    page.locator(sel).first.click(force=True, timeout=6000)
                    last = sel + ":forced"
                    clicked = True
                    break
                except Exception:
                    continue
        if clicked:
            break
        page.wait_for_timeout(4000)

    # The click either navigates this tab to accounts.google.com or opens it as a
    # new page. Check every page in the context, not just the last one: the opener
    # can be replaced, and pages[-1] is often still about:blank at this point.
    for _ in range(30):
        try:
            pages = list(page.context.pages)
        except Exception:
            pages = [page]
        for p in pages:
            try:
                if "accounts.google.com" in (p.url or ""):
                    try:
                        p.wait_for_load_state("domcontentloaded", timeout=40000)
                    except Exception:
                        pass
                    kind = "same-tab" if p is page else "popup"
                    return p, f"{kind}:{last}"
            except Exception:
                continue
        try:
            page.wait_for_timeout(1000)
        except Exception:
            time.sleep(1)
    if not clicked:
        return None, f"google-button-not-clickable:{last}"
    return None, f"google-click-no-navigation:{last}"


def google_credentials(gp, ctx, email, pw, log):
    """Identifier step, password step, challenge detection and consent screens —
    everything after the Google entry point has already been clicked.

    Split out of google_login so other Google-OAuth consumers (v1m.ir) can reuse
    the credential half without chat.z.ai's button-clicking half.
    """
    if not gp:
        return None, "no-google-page"
    log(f"  google page: {gp.url[:110]}")

    # identifier step
    filled = False
    for sel in ['input[name="identifier"]', 'input[type="email"]']:
        try:
            gp.fill(sel, email, timeout=15000)
            filled = True
            break
        except Exception:
            pass
    if not filled:
        return None, f"no-identifier-field url={gp.url[:80]}"
    for sel in ["#identifierNext", 'button:has-text("Next")']:
        try:
            gp.click(sel, timeout=8000)
            break
        except Exception:
            pass
    time.sleep(6)

    body = " ".join(gp.inner_text("body").split()) if gp.query_selector("body") else ""
    if "deleted" in gp.url or "账号已被删除" in body or "account deleted" in body.lower():
        return None, "google-account-deleted"
    if "couldn't find" in body.lower() or "找不到" in body:
        return None, "google-identifier-unknown"

    # password step — detect from DOM, never from body text (Google localises)
    has_pw = False
    for _ in range(3):
        for sel in ['input[name="hiddenPassword"]', 'input[type="password"]']:
            try:
                if gp.query_selector(sel):
                    has_pw = True
                    break
            except Exception:
                pass
        if has_pw:
            break
        time.sleep(4)

    # Passkey-first prompt: Google offers "Use your passkey" before ever showing a
    # password field for accounts that have one enrolled. The password route is
    # still available behind "Try another way" → "Enter your password".
    if not has_pw:
        low_body = body.lower()
        if "passkey" in low_body or "your device" in low_body:
            log("  passkey prompt detected — routing to password")
            for _ in range(4):
                if _click_text(gp, ["^try another way$", "^coba cara lain$", "^other ways to sign in$"]):
                    break
                time.sleep(2)
            time.sleep(4)
            for _ in range(4):
                if _click_text(gp, ["enter your password", "masukkan kata sandi",
                                    "use your password", "password"]):
                    break
                time.sleep(2)
            time.sleep(5)
            for _ in range(3):
                for sel in ['input[name="hiddenPassword"]', 'input[type="password"]']:
                    try:
                        if gp.query_selector(sel):
                            has_pw = True
                            break
                    except Exception:
                        pass
                if has_pw:
                    break
                time.sleep(4)

    if not has_pw:
        return None, f"no-password-step: {body[:100]}"

    done = False
    for sel in ['input[name="hiddenPassword"]', 'input[type="password"]']:
        try:
            gp.fill(sel, pw, timeout=10000)
            done = True
            break
        except Exception:
            pass
    if not done:
        return None, "password-fill-failed"
    for sel in ["#passwordNext", 'button:has-text("Next")']:
        try:
            gp.click(sel, timeout=8000)
            break
        except Exception:
            pass
    time.sleep(8)

    # wrong-password / challenge detection
    txt = " ".join(gp.inner_text("body").split()) if gp.query_selector("body") else ""
    low = txt.lower()
    if "wrong password" in low or "密码不正确" in txt or "couldn't sign you in" in low:
        return None, f"google-wrong-password: {txt[:90]}"
    if "verify it" in low or "2-step" in low or "2-step verification" in low or "tap yes" in low:
        return None, "google-2fa-required"
    if "captcha" in low and "unusual traffic" in low:
        return None, "google-captcha"

    # consent screens
    for _ in range(4):
        hit = _click_text(gp, ["^continue$", "^lanjutkan$", "^allow$", "^izinkan$",
                               "^setuju$", "^i agree$", "^terima$"])
        if hit:
            log(f"  google consent clicked: {hit}")
        time.sleep(3)
    return gp, "ok"


def google_login(page, ctx, email, pw, log):
    """Sign in on accounts.google.com. Handles same-tab and popup variants."""
    gp, clicked = _click_google(page)
    if gp is None:
        return None, clicked  # carries the real reason, not a generic label
    log(f"  google entry clicked: {clicked}")
    return google_credentials(gp, ctx, email, pw, log)


def zcode_consent(page, log):
    """chat.z.ai / zcode consent page: tick ToS checkbox then Continue."""
    for attempt in range(3):
        try:
            page.evaluate(
                """() => {
                const cbs = [...document.querySelectorAll('input[type=checkbox]')];
                for (const c of cbs) { if (!c.checked) c.click(); }
            }"""
            )
        except Exception:
            pass
        time.sleep(1)
        hit = _click_text(page, ["^continue$", "^lanjutkan$", "^authorize$", "^approve$", "^allow$"])
        if hit:
            log(f"  zcode consent clicked: {hit}")
            time.sleep(3)
        else:
            break
    return True


def do_one(email, pw, log):
    poll_token, flow_id, auth_url = init_flow()
    log(f"  flow={flow_id} url={auth_url[:90]}")

    from camoufox.sync_api import Camoufox

    with Camoufox(headless=True, proxy={"server": WARP}, geoip=True) as browser:
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(auth_url, wait_until="domcontentloaded", timeout=90000)
        time.sleep(7)
        log(f"  landed: {page.url[:110]}")

        if "accounts.google.com" not in page.url:
            gp, status = google_login(page, ctx, email, pw, log)
            if status != "ok":
                return None, status
        else:
            # already on Google (rare) — reuse the login helper with the same page
            ctx2 = ctx
            gp, status = google_login(page, ctx2, email, pw, log)
            if status != "ok":
                return None, status

        # wait for the zcode consent surface (either in the popup or the tab)
        target = page
        time.sleep(6)
        if "zcode.z.ai" in gp.url or "chat.z.ai" in gp.url:
            target = gp
        try:
            target.wait_for_load_state("domcontentloaded", timeout=30000)
        except Exception:
            pass
        txt = " ".join(target.inner_text("body").split())[:300] if target.query_selector("body") else ""
        log(f"  post-login url: {target.url[:110]} text={txt[:120]}")
        zcode_consent(target, log)
        time.sleep(4)

    res = poll_flow(poll_token, flow_id)
    if not res:
        return None, "poll-timeout"
    d = res.get("data") or {}
    if d.get("status") != "ready":
        return None, f"status={d.get('status')}"
    token = d.get("token", "")
    zai_at = (d.get("zai") or {}).get("access_token", "")
    if not token:
        return None, "no-token-in-ready"
    return {"token": token, "zai_at": zai_at, "user": d.get("user") or {}}, "ok"


def save_token(email, token, zai_at):
    conn = sqlite3.connect(DB, timeout=30)
    try:
        row = conn.execute(
            "SELECT id, data FROM providerConnections WHERE provider='zcode' AND lower(email)=?",
            (email.lower(),),
        ).fetchone()
        saved_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        if not row:
            return "no-db-row"
        rid, raw = row
        d = json.loads(raw) if raw else {}
        psd = d.get("providerSpecificData") or {}
        psd["zcodeJwtToken"] = token
        psd["zaiAccessToken"] = zai_at
        psd["zcodeJwtSavedAt"] = saved_at
        d["providerSpecificData"] = psd
        d["testStatus"] = "active"
        d["backoffLevel"] = 0
        d["lastError"] = None
        d["errorCode"] = None
        d["lastErrorAt"] = None
        d["lastErrorType"] = None
        for k in [k for k in d if k.startswith("modelLock_")]:
            del d[k]
        conn.execute(
            "UPDATE providerConnections SET data=?, updatedAt=datetime('now') WHERE id=?",
            (json.dumps(d), rid),
        )
        conn.commit()
        return "saved"
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--all", action="store_true", help="process every account in the list")
    ap.add_argument("--email", action="append", default=[])
    ap.add_argument("--force", action="store_true", help="refresh even when the JWT is <24h old")
    ap.add_argument("--lock", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--dry", action="store_true", help="run the flow but do not write the DB")
    args = ap.parse_args()

    lock_fd = None
    if args.lock:
        try:
            lock_fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(lock_fd, str(os.getpid()).encode())
        except FileExistsError:
            print(f"refresh already running: {LOCK_PATH}")
            return 2

    try:
        if not args.no_backup and not args.dry:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            dst = os.path.join(BACKUP_DIR, time.strftime("data-%Y%m%d-%H%M%S.sqlite"))
            shutil.copy2(DB, dst)
            print(f"sqlite backup: {dst}")

        accounts = load_accounts()
        if args.email:
            wanted = [e.lower() for e in args.email]
        else:
            wanted = [e for e in accounts if e.startswith("zcode")] if False else list(accounts)
        todo = []
        for e in wanted:
            if e not in accounts:
                print(f"skip (not in list): {e}")
                continue
            if not args.force:
                fresh, why = already_fresh(e)
                if fresh:
                    print(f"skip (fresh {why}): {e}")
                    continue
            todo.append(e)
        if not args.all:
            todo = todo[: args.limit]
        print(f"accounts to process: {len(todo)} | MemAvailable: {mem_avail_mb()}MB")

        results = {"ok": [], "fail": []}
        for i, email in enumerate(todo, 1):
            if mem_avail_mb() < MIN_AVAIL_MB:
                print(f"MEMORI TIPIS ({mem_avail_mb()}MB) — stop.", flush=True)
                break
            print(f"[{i}/{len(todo)}] {email}", flush=True)

            def log(msg):
                print(msg, flush=True)

            try:
                res, status = do_one(email, accounts[email], log)
            except Exception as exc:  # noqa: BLE001
                res, status = None, f"ERR {str(exc)[:120]}"
            if res:
                if args.dry:
                    print(f"  DRY ok JWT {len(res['token'])}c (not saved)", flush=True)
                else:
                    print(f"  saved: {save_token(email, res['token'], res['zai_at'])}"
                          f" JWT {len(res['token'])}c zai_at {len(res['zai_at'])}c", flush=True)
                results["ok"].append(email)
                with open(PROGRESS_PATH, "a") as fh:
                    fh.write(email + "\n")
            else:
                print(f"  FAIL {status}", flush=True)
                results["fail"].append({"email": email, "err": status})
            time.sleep(3)

        print("\n=== SUMMARY ===")
        print(f"OK: {len(results['ok'])} | FAIL: {len(results['fail'])}")
        with open(RESULT_PATH, "w") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
        return 0 if results["ok"] else 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
            try:
                os.unlink(LOCK_PATH)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    sys.exit(main())
