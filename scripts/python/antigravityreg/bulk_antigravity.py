#!/usr/bin/env python3
"""
Bulk Antigravity (GSuite SSO) registration -> VansRouter provider pool.
Requires: ~/.gsuite/accounts.json  [{email, password}, ...]
Each account: run antigravity_auth.py (Camoufox+WARP Google login) -> token at
~/.gemini/antigravity-cli/antigravity-oauth-token -> import to VansRouter DB.

USAGE: python3 bulk_antigravity.py [--limit N] [--offset M]
"""
import json, os, sys, subprocess, glob, time

GSUITE_POOL = os.path.expanduser("~/.gsuite/accounts.json")
AUTH_SCRIPT = os.path.join(os.path.dirname(__file__), "antigravity_auth.py")
TOKEN_GLOB = os.path.expanduser("~/.gemini/antigravity-cli/antigravity-oauth-token*")
VR_DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"

def load_pool():
    if not os.path.exists(GSUITE_POOL):
        print(f"[X] GSuite pool not found: {GSUITE_POOL}")
        sys.exit(1)
    with open(GSUITE_POOL) as f:
        return json.load(f)

def run_one(email, password):
    # Clear stale token so we capture fresh one
    for t in glob.glob(TOKEN_GLOB):
        try: os.remove(t)
        except: pass
    print(f"[>] {email}")
    r = subprocess.run(["python3", AUTH_SCRIPT, email, password],
                       capture_output=True, text=True, timeout=180)
    for line in r.stdout.splitlines():
        if line.startswith("GOT_CODE") or line.startswith("AGY_FINAL"):
            print("   ", line[:120])
    tokens = glob.glob(TOKEN_GLOB)
    if not tokens:
        print(f"[!] {email}: NO TOKEN (auth failed)"); return False
    tok = json.load(open(tokens[0]))
    print(f"[+] {email}: OK access_token len={len(tok.get('access_token',''))}")
    # TODO: import token into VansRouter providerConnections (provider=antigravity)
    return True

if __name__ == "__main__":
    pool = load_pool()
    limit = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--limit")), len(pool)))
    offset = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--offset")), 0))
    batch = pool[offset:offset+limit]
    print(f"[*] Pool={len(pool)} running {offset}..{offset+len(batch)}")
    ok = 0
    for acc in batch:
        if run_one(acc["email"], acc["password"]): ok += 1
        time.sleep(5)
    print(f"[DONE] {ok}/{len(batch)} success")
