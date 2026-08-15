#!/usr/bin/env python3
"""Kiro batch farm: 110 GSuite → login Google SSO → cookies + ARN + models.
Output: /tmp/kiro_results.tsv (email, status, arn, models)
"""
import sys, time, json, os, re, subprocess

ACCOUNTS_FILE = "/home/ubuntu/Avres Second Brain/Avres Second Brain/VansRouter/gsuite-bty-110-accounts.txt"
OUT_DIR = "/tmp/kiro_batch"
os.makedirs(OUT_DIR, exist_ok=True)
results = []

def run_one(email, pw, idx):
    out = f"{OUT_DIR}/acc_{idx:03d}.txt"
    cmd = [
        "/home/ubuntu/VansRouter/scripts/python/qoderreg-venv/bin/python",
        "/tmp/kiro_batch_one.py", email, pw, out,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=150, env={**os.environ, "DISPLAY": ":99"})
        log = r.stdout + r.stderr
        if "app.kiro.dev/home" in log or "kiro cookies:" in log:
            arn = "NONE"
            # ambil ARN dari GetUserInfo jika tersimpan di log
            m = re.search(r"ARN: (\S+)", log)
            if m:
                arn = m.group(1)
            ok = "URL: https://app.kiro.dev/home" in log or "kiro cookies: [6-9]" in log
            status = "ok" if ok else "partial"
            return {"email": email, "status": status, "arn": arn, "cookies_file": out, "log": log[-200:]}
        return {"email": email, "status": "failed", "arn": "NONE", "cookies_file": out, "log": log[-200:]}
    except subprocess.TimeoutExpired:
        return {"email": email, "status": "timeout", "arn": "NONE", "cookies_file": out, "log": "timeout"}
    except Exception as e:
        return {"email": email, "status": "error", "arn": "NONE", "cookies_file": out, "log": str(e)[:200]}

def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 110
    accs = [l.strip().split("|") for l in open(ACCOUNTS_FILE) if "|" in l]
    print(f"total accounts: {len(accs)}", flush=True)
    for i in range(start, min(start + count, len(accs))):
        email, pw = accs[i][0].strip(), accs[i][1].strip()
        print(f"[{i}/{len(accs)}] {email} ...", flush=True)
        res = run_one(email, pw, i)
        results.append(res)
        print(f"  -> {res['status']} cookies={os.path.getsize(res['cookies_file']) if os.path.exists(res['cookies_file']) else 0}B", flush=True)
        # sleep singkat antar akun
        time.sleep(3)
    # summary
    ok = sum(1 for r in results if r["status"] == "ok")
    print(f"\n=== DONE: {ok}/{len(results)} ok ===", flush=True)
    with open("/tmp/kiro_results.tsv", "w") as f:
        for r in results:
            f.write(f"{r['email']}\t{r['status']}\t{r['arn']}\t{r['cookies_file']}\n")
    print("saved /tmp/kiro_results.tsv", flush=True)

if __name__ == "__main__":
    main()
