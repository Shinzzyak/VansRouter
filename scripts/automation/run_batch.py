#!/usr/bin/env python3
"""VansRouter automation runner — bulk farm + verify semua provider GSuite.
Usage:
  python3 run_batch.py farm zcode [start] [count]
  python3 run_batch.py farm kimchi [start] [count]
  python3 run_batch.py farm antigravity [start] [count]
  python3 run_batch.py farm kiro [start] [count]
  python3 run_batch.py verify [provider]
  python3 run_batch.py status
"""
import sys, os, subprocess, json, time, sqlite3

SCRIPTS = "/home/ubuntu/VansRouter/scripts/python"
DB_PATH = "/home/ubuntu/VansRouter/data/db/data.sqlite"

PROVIDERS = {
    "zcode":        {"script": "zcodereg/zcode_bulk_gsuite.py",          "python": "/home/ubuntu/camoufox-env/bin/python"},
    "kimchi":       {"script": "kimchireg/cast_bulk_gsuite.py",          "python": "/home/ubuntu/VansRouter/scripts/python/qoderreg-venv/bin/python"},
    "antigravity":  {"script": "antigravityreg/ag_bulk_gsuite.py",       "python": "/home/ubuntu/camoufox-env/bin/python"},
    "kiro":         {"script": "kiroreg/kiro_bulk_gsuite.py",            "python": "/home/ubuntu/VansRouter/scripts/python/qoderreg-venv/bin/python"},
    "cline":        {"script": "cline/cline_bulk_gsuite.py",             "python": "/home/ubuntu/camoufox-env/bin/python"},
}

def db_count(provider=None):
    conn = sqlite3.connect(DB_PATH)
    if provider:
        n = conn.execute("SELECT COUNT(*) FROM providerConnections WHERE provider=?", (provider,)).fetchone()[0]
    else:
        n = conn.execute("SELECT COUNT(*) FROM providerConnections").fetchone()[0]
    conn.close()
    return n

def cmd_farm(provider, start, count):
    if provider not in PROVIDERS:
        print(f"unknown provider: {provider}. Known: {', '.join(PROVIDERS)}")
        return 1
    p = PROVIDERS[provider]
    script = os.path.join(SCRIPTS, p["script"])
    if not os.path.exists(script):
        print(f"script missing: {script}")
        return 1
    print(f"== farming {provider} [{start}:{start+count}] ==", flush=True)
    r = subprocess.run([p["python"], script, str(start), str(count)],
                       env={**os.environ, "DISPLAY": ":99"})
    print(f"== done. {provider} total in DB: {db_count(provider)} ==", flush=True)
    return r.returncode

def cmd_status():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT provider, COUNT(*) FROM providerConnections GROUP BY provider ORDER BY COUNT(*) DESC").fetchall()
    conn.close()
    print(f"Total connections: {sum(n for _, n in rows)}")
    for p, n in rows:
        print(f"  {p}: {n}")

def cmd_verify(provider=None):
    v = "/tmp/verify_all_providers.py"
    if os.path.exists(v):
        r = subprocess.run(["/home/ubuntu/camoufox-env/bin/python", v],
                           env={**os.environ, "DISPLAY": ":99"})
        return r.returncode
    print("verify_all_providers.py not found")
    return 1

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "farm":
        provider = sys.argv[2]
        start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        count = int(sys.argv[4]) if len(sys.argv) > 4 else 110
        sys.exit(cmd_farm(provider, start, count))
    elif cmd == "status":
        cmd_status()
    elif cmd == "verify":
        sys.exit(cmd_verify(sys.argv[2] if len(sys.argv) > 2 else None))
    else:
        print(__doc__)
