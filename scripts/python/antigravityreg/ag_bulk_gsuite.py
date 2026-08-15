#!/usr/bin/env python3
"""AG batch final: run semua akun dari list, simpan token per akun."""
import sys, os, subprocess, time

list_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ag_todo.txt"
emails = [l.strip() for l in open(list_file) if l.strip()]
accs = {}
for l in open("/home/ubuntu/Avres Second Brain/Avres Second Brain/VansRouter/gsuite-bty-110-accounts.txt"):
    parts = l.strip().split("|")
    if len(parts) >= 2:
        accs[parts[0].strip()] = parts[1].strip()

ok = 0
for i, email in enumerate(emails):
    pw = accs.get(email, "")
    if not pw:
        print(f"[{i}] {email} NO_PW", flush=True)
        continue
    print(f"[{i}] {email} ...", flush=True)
    try:
        r = subprocess.run(
            ["/home/ubuntu/camoufox-env/bin/python", "/tmp/ag_batch_v2.py", "--single", email, pw],
            capture_output=True, text=True, timeout=240,
            env={**os.environ, "DISPLAY": ":99"},
        )
        log = r.stdout + r.stderr
        # cek apakah RT tersimpan
        tok = f"/tmp/ag_tokens/{email.replace('@','_')}.json"
        if os.path.exists(tok):
            ok += 1
            print(f"  -> ok", flush=True)
        else:
            print(f"  -> fail: {log[-80:]}", flush=True)
    except subprocess.TimeoutExpired:
        print("  -> timeout", flush=True)
    # bersihkan zombie tiap 3 akun
    if i % 3 == 2:
        os.system("pkill -9 -f camoufox-bin 2>/dev/null")
    time.sleep(1)
print(f"=== DONE {ok}/{len(emails)} ===")
