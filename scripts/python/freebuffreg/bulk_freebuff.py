#!/usr/bin/env python3
"""
Freebuff bulk device-code approve + API key harvest (GSuite pool).
1. POST /api/auth/cli/code {fingerprintId} → loginUrl
2. approve_flow.py: Camoufox + WARP → Google SSO (GSuite) → approve
3. GET /api/auth/cli/status → authToken = API key
4. Simpan ke VansRouter DB (providerConnections provider='freebuff')

Cara pakai:
  python3 bulk_freebuff.py accounts.txt [--db /path/data.sqlite] [--concurrency 1]
accounts.txt: email:password per baris (GSuite pool)
"""
import argparse, asyncio, json, os, subprocess, sys, time, uuid
import sqlite3, urllib.request, urllib.error

API_BASE = "https://freebuff.com/api/auth/cli"
DB_DEFAULT = "/home/ubuntu/VansRouter/data/db/data.sqlite"
APPROVE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "approve_flow.py")
CAMOUFOX_PY = "/home/ubuntu/camoufox-env/bin/python"

def request_code():
    fid = str(uuid.uuid4())
    req = urllib.request.Request(f"{API_BASE}/code", data=json.dumps({"fingerprintId": fid}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    r = json.loads(urllib.request.urlopen(req, timeout=20).read())
    r["fingerprintId"] = fid
    return r

def poll_status(fid, fhash, expires_at, timeout_s=180):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        url = f"{API_BASE}/status?fingerprintId={fid}&fingerprintHash={fhash}&expiresAt={expires_at}"
        try:
            r = json.loads(urllib.request.urlopen(url, timeout=15).read())
            if r.get("user", {}).get("authToken"):
                return r
        except Exception:
            pass
        time.sleep(5)
    return None

def save_connection(db, email, auth_token, fid):
    conn = sqlite3.connect(db)
    data = json.dumps({
        "authMethod": "device",
        "loginEmail": email,
        "fingerprintId": fid,
        "automation": "freebuff-bulk",
    })
    conn.execute(
        "INSERT INTO providerConnections (provider, authType, name, email, isActive, data) VALUES (?,?,?,?,1,?)",
        ("freebuff", "oauth", email, email, data),
    )
    conn.commit()
    conn.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("accounts_file")
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--concurrency", type=int, default=1)
    args = ap.parse_args()

    accounts = []
    for line in open(args.accounts_file):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            email, pw = line.split(":", 1)
        elif "|" in line:
            email, pw = line.split("|", 1)
        else:
            continue
        accounts.append((email.strip(), pw.strip()))
    print(f"Accounts: {len(accounts)}")

    done = 0
    for i, (email, pw) in enumerate(accounts):
        try:
            code = request_code()
            login_url = code.get("loginUrl", "")
            expires_at = code.get("expiresAt")
            fid = code.get("fingerprintId")
            fhash = code.get("fingerprintHash", "")
            print(f"[{i+1}/{len(accounts)}] {email}: approve via browser...")
            subprocess.run(
                [CAMOUFOX_PY, APPROVE_SCRIPT, login_url, email, pw],
                timeout=180, capture_output=True,
            )
            st = poll_status(fid, fhash, expires_at)
            if st and st.get("user", {}).get("authToken"):
                token = st["user"]["authToken"]
                save_connection(args.db, email, token, fid)
                print(f"  ✓ {email}: API key {token[:8]}... saved")
                done += 1
            else:
                print(f"  ✗ {email}: approve timeout/gagal")
        except Exception as e:
            print(f"  ✗ {email}: {str(e)[:80]}")
        time.sleep(3)
    print(f"\nDONE: {done}/{len(accounts)} API keys saved")

if __name__ == "__main__":
    main()