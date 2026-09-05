#!/usr/bin/env python3
"""BULK ZCode OAuth CLI flow — semua akun zcode active.
Per akun: init -> Camoufox consent (checkbox+continue) -> poll -> JWT -> save DB.
Rate-limit: sleep antar akun + per-flow timeout. REUSE satu browser ctx pers akun (cookies beda).
"""
import sys, os, json, time, secrets, sqlite3, urllib.request, urllib.error, subprocess, calendar

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
WARP_PROXY = "socks5://127.0.0.1:40000"
LOCK_PATH = "/tmp/zcode-oauth-refresh.lock"

import socks
from urllib.parse import urlparse

warp_url = urlparse(WARP_PROXY)


def get_accounts(limit=None, include_stale_jwt=True):
    """include_stale_jwt=True: proses juga akun yang sudah bawa zcodeJwtToken (yang lama expired).
    Use include_stale_jwt=False utk perilaku lama (skip yang ber-JWT)."""
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode' AND isActive=1").fetchall()
    conn.close()
    out = []
    for email, data in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        psd = d.get("providerSpecificData") or {}
        jwt = psd.get("zcodeJwtToken")
        if jwt and not include_stale_jwt:
            continue
        # Skip fresh JWT (<24h) even in stale mode — biar cron refresh hemat
        if jwt and include_stale_jwt and psd.get("zcodeJwtSavedAt"):
            try:
                saved = calendar.timegm(time.strptime(psd["zcodeJwtSavedAt"][:19], "%Y-%m-%dT%H:%M:%S"))
                if time.time() - saved < 86400:
                    continue
            except Exception:
                pass
        out.append({"email": email, "cookies": psd.get("cookies", [])})
    if limit:
        out = out[:limit]
    return out


def inject_cookies(ctx, cookies):
    n = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom:
            continue
        try:
            if dom in ("chat.z.ai", "zcode.z.ai", "z.ai", "accounts.google.com", "google.com"):
                ctx.add_cookies([{"name": c["name"], "value": c["value"], "url": "https://" + dom}])
            else:
                ctx.add_cookies([{"name": c["name"], "value": c["value"], "domain": dom.lstrip("."), "path": "/"}])
            n += 1
        except Exception:
            pass
    return n


def init_flow():
    poll_token = secrets.token_hex(32)
    hdrs = {"Content-Type": "application/json", "Authorization": f"Bearer {poll_token}"}
    # route via WARP socks
    socks.set_default_proxy(socks.SOCKS5, warp_url.hostname, warp_url.port)
    import socket
    socket.socket = socks.socksocket
    r = urllib.request.Request("https://zcode.z.ai/api/v1/oauth/cli/init", data=json.dumps({"provider": "zai"}).encode(), headers=hdrs, method="POST")
    with urllib.request.urlopen(r, timeout=25) as resp:
        j = json.loads(resp.read().decode())
    d = j["data"]
    return poll_token, d["flow_id"], d["authorize_url"]


def poll_flow(poll_token, flow_id, tries=30, interval=2):
    url = f"https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}"
    socks.set_default_proxy(socks.SOCKS5, warp_url.hostname, warp_url.port)
    import socket
    socket.socket = socks.socksocket
    for i in range(tries):
        try:
            r = urllib.request.Request(url, headers={"Authorization": f"Bearer {poll_token}"})
            with urllib.request.urlopen(r, timeout=15) as resp:
                j = json.loads(resp.read().decode())
            st = j.get("data", {}).get("status", "?")
            if st != "pending":
                return j
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        time.sleep(interval)
    return None


def do_one(email, cookies):
    poll_token, flow_id, auth_url = init_flow()
    from camoufox.sync_api import Camoufox
    # Camoufox lewat WARP proxy
    with Camoufox(headless=True, proxy={"server": WARP_PROXY}) as browser:
        ctx = browser.new_context()
        inject_cookies(ctx, cookies)
        page = ctx.new_page()
        page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        # tunggu consent page render (hingga 15s)
        for _ in range(15):
            has_continue = page.evaluate("""() => {
                const btns=[...document.querySelectorAll('button')];
                return btns.some(x=>x.innerText.trim().toLowerCase()==='continue');
            }""")
            if has_continue:
                break
            page.wait_for_timeout(1000)
        # check ToS checkbox (mungkin per-permukaan consent)
        page.evaluate("""() => {
            const cbs=[...document.querySelectorAll('input[type=checkbox]')];
            if (cbs.length) cbs[0].click();
        }""")
        page.wait_for_timeout(500)
        # click Continue (beberapa kali, dengan delay — consent 2-step)
        clicked = False
        for _ in range(3):
            clicked = page.evaluate("""() => {
                const btns=[...document.querySelectorAll('button')];
                const b=btns.find(x=>x.innerText.trim().toLowerCase()==='continue');
                if(b){b.click();return true;}
                return false;
            }""")
            if not clicked:
                break
            page.wait_for_timeout(3000)
        if not clicked:
            # dump untuk debug — tapi cek kalau sudah Authorization Successful
            txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,300) : ''")
            low = txt.lower()
            if "authorization successful" in low or "authorization success" in low or "redirecting" in low or "授权成功" in txt:
                pass  # sudah sukses — lanjut poll
            else:
                return None, f"no continue: {txt[:80]}"
        page.wait_for_timeout(5000)
    res = poll_flow(poll_token, flow_id, tries=30, interval=2)
    if not res:
        return None, "poll timeout"
    d = res.get("data", {})
    if d.get("status") != "ready":
        return None, f"status {d.get('status')}"
    tok = d.get("token", "")
    at = (d.get("zai") or {}).get("access_token", "")
    return {"token": tok, "zai_at": at, "user": d.get("user", {})}, "ok"


def save_token(email, tok, at):
    saved_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    script = f'''
const {{DatabaseSync}}=require("node:sqlite");
const db=new DatabaseSync("{DB}");
const r=db.prepare("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?").get("{email}");
if(r){{
  const d=JSON.parse(r.data);
  const psd=d.providerSpecificData||{{}};
  psd.zcodeJwtToken="{tok}";
  psd.zaiAccessToken="{at}";
  psd.zcodeJwtSavedAt="{saved_at}";
  d.providerSpecificData=psd;
  d.testStatus="active"; d.backoffLevel=0; d.lastError=null; d.errorCode=null;
  for(const k of Object.keys(d)){{ if(k.startsWith("modelLock_")) delete d[k]; }}
  db.prepare("UPDATE providerConnections SET data=? WHERE email=?").run(JSON.stringify(d), "{email}");
  console.log("saved");
}}
'''
    res = subprocess.run(["node", "-e", script], cwd="/home/ubuntu/VansRouter", capture_output=True, text=True)
    return res.stdout.strip()


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="proses N akun pertama saja")
    ap.add_argument("--email", action="append", default=[], help="proses email tertentu (bisa berulang)")
    ap.add_argument("--lock", action="store_true", help="cegah dua bulk refresh berjalan bersamaan")
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
        if args.email:
            accounts = [a for a in get_accounts() if a["email"] in args.email]
        else:
            accounts = get_accounts(limit=args.limit)
        print(f"accounts to process: {len(accounts)}")
        results = {"ok": [], "fail": []}
        for i, acc in enumerate(accounts):
            email = acc["email"]
            print(f"[{i+1}/{len(accounts)}] {email} ...", flush=True)
            try:
                res, status = do_one(email, acc["cookies"])
                if res and status == "ok":
                    s = save_token(email, res["token"], res["zai_at"])
                    print(f"  ✓ JWT {len(res['token'])}c saved ({s})", flush=True)
                    results["ok"].append(email)
                else:
                    print(f"  ✗ {status}", flush=True)
                    results["fail"].append({"email": email, "err": status})
            except Exception as e:
                print(f"  ✗ ERR {str(e)[:120]}", flush=True)
                results["fail"].append({"email": email, "err": str(e)[:120]})
            time.sleep(3)
        print("\n=== SUMMARY ===")
        print("OK:", len(results["ok"]), "| FAIL:", len(results["fail"]))
        with open("/tmp/zcode_bulk_oauth_result.json", "w") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        return 0 if not results["fail"] else 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
            try:
                os.unlink(LOCK_PATH)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()