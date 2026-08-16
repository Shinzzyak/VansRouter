#!/usr/bin/env python3
"""ZCode batch farm (resmi): 110 GSuite → Google SSO → JWT + cookies → DB.
Pipeline: login Google → chat.z.ai/auth#token= → simpan token+cookies → insert providerConnections.

Usage: python3 zcode_bulk_gsuite.py [start_idx] [count]
Output: /tmp/zcode_batch/acc_<idx>.json (token + cookies)
DB: providerConnections (provider='zcode')
"""
import sys, time, json, os, sqlite3, subprocess, re, random

ACCOUNTS_FILE = "/home/ubuntu/Avres Second Brain/Avres Second Brain/VansRouter/gsuite-bty-110-accounts.txt"
OUT_DIR = "/tmp/zcode_batch"
DB_PATH = "/home/ubuntu/VansRouter/data/db/data.sqlite"
PYTHON = "/home/ubuntu/camoufox-env/bin/python"
os.makedirs(OUT_DIR, exist_ok=True)

ONE_SHOT = r'''
import sys, time, json
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from camoufox import Camoufox

email, pw, out = sys.argv[1], sys.argv[2], sys.argv[3]

def grab(page):
    tok = ""
    u = page.url
    if "#token=" in u:
        tok = u.split("#token=")[1].split("&")[0][:2000]
    if not tok:
        for _ in range(40):
            cur = page.evaluate("() => localStorage.getItem('token') || ''")
            if cur and len(cur) >= 20:
                tok = cur
                break
            page.wait_for_timeout(1000)
    if not tok or len(tok) < 20:
        return None
    cookies = page.context.cookies()
    return {"token": tok, "cookies": [{"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c.get("path", "/")} for c in cookies]}

with Camoufox(headless=False) as browser:
    page = browser.new_page()
    page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    # klik login
    clicked = False
    for sel in ["button:has-text('Log in')", "button:has-text('Sign in')", "button:has-text('Login')", "a:has-text('Log in')", "a:has-text('Sign in')"]:
        try:
            el = page.locator(sel).first
            if el.count():
                el.click(timeout=5000)
                clicked = True
                break
        except Exception:
            continue
    if not clicked:
        page.goto("https://chat.z.ai/auth", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    # klik Google
    for sel in ["button:has-text('Google')", "button:has-text('Continue with Google')", "[class*=google]"]:
        try:
            el = page.locator(sel).first
            if el.count():
                el.click(timeout=8000)
                break
        except Exception:
            continue
    # Google login
    try:
        page.wait_for_selector("#identifierId", timeout=20000)
        page.fill("#identifierId", email)
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        try:
            page.wait_for_selector("input[type=password]", timeout=25000)
            page.fill("input[type=password]", pw)
            page.keyboard.press("Enter")
        except Exception:
            pass
    except Exception:
        pass
    # consent + tunggu redirect
    for i in range(60):
        page.wait_for_timeout(1500)
        u = page.url
        if "accounts.google" in u or "consent" in u:
            for sel in ["button:has-text('Continue')", "button:has-text('Lanjutkan')", "button[jsname=LgbsSe]"]:
                try:
                    b = page.locator(sel).first
                    if b.count():
                        b.click(timeout=800)
                        page.wait_for_timeout(1000)
                except Exception:
                    pass
        if "chat.z.ai" in u and "accounts.google" not in u and "auth" not in u:
            break
        if "#token=" in u or "auth#token=" in u:
            break
        if i == 59:
            print("TIMEOUT " + u[:80])
            sys.exit(1)
    page.wait_for_timeout(8000)
    rec = grab(page)
    if rec:
        json.dump(rec, open(out, "w"))
        print("OK " + email + " " + str(len(rec["token"])) + " " + str(len(rec["cookies"])))
    else:
        print("NO_TOKEN")
'''

def run_one(email, pw, idx):
    out = f"{OUT_DIR}/acc_{idx:03d}.json"
    if os.path.exists(out) and os.path.getsize(out) > 200:
        return {"email": email, "status": "ok(cached)", "file": out}
    cmd = [PYTHON, "-c", ONE_SHOT, email, pw, out]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=170,
                           env={**os.environ, "DISPLAY": ":99"})
        log = r.stdout + r.stderr
        if "OK " in log and os.path.exists(out):
            return {"email": email, "status": "ok", "file": out, "log": log[-200:]}
        return {"email": email, "status": "failed", "file": out, "log": log[-200:]}
    except subprocess.TimeoutExpired:
        return {"email": email, "status": "timeout", "file": out, "log": "timeout"}
    except Exception as e:
        return {"email": email, "status": "error", "file": out, "log": str(e)[:200]}

def insert_db(email, rec):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    data = json.dumps({
        "accessToken": rec["token"],
        "providerSpecificData": {"cookies": rec["cookies"]},
        "refreshToken": "",
    })
    # cek ada
    row = cur.execute("SELECT id FROM providerConnections WHERE provider=? AND email=?",
                      ("zcode", email)).fetchone()
    if row:
        cur.execute("UPDATE providerConnections SET data=? WHERE id=?", (data, row[0]))
    else:
        cur.execute(
            "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(uuid4()), "zcode", "web", email.split("@")[0].replace(".", " ").title(),
             email, 141, 1, data, int(time.time()), int(time.time())))
    conn.commit()
    conn.close()

def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 110
    accs = [l.strip().split("|") for l in open(ACCOUNTS_FILE) if "|" in l]
    print(f"total: {len(accs)}, range: {start}-{min(start+count, len(accs))}", flush=True)
    ok = 0
    for i in range(start, min(start + count, len(accs))):
        email, pw = accs[i][0].strip(), accs[i][1].strip()
        print(f"[{i}] {email} ...", flush=True)
        res = run_one(email, pw, i)
        if res["status"].startswith("ok"):
            try:
                rec = json.load(open(res["file"]))
                insert_db(email, rec)
                ok += 1
                print(f"  -> ok ({len(rec['token'])} tok, {len(rec['cookies'])} ck)", flush=True)
            except Exception as e:
                print(f"  -> db-error: {e}", flush=True)
        else:
            print(f"  -> {res['status']}", flush=True)
        time.sleep(random.uniform(2, 5))
    print(f"DONE ok={ok}/{min(count, len(accs)-start)}", flush=True)

from uuid import uuid4
main()
