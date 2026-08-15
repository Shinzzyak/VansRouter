#!/usr/bin/env python3
"""VERIFIKASI MASSAL — test chat semua provider via router, report status.
Anti-merah: sebelum claim akun OK, test dulu. Output: per-provider pass/fail + latency.
"""
import json, subprocess, sys, time

MID = open("/home/ubuntu/VansRouter/data/machine-id").read().strip()
SECRET = open("/home/ubuntu/VansRouter/data/auth/cli-secret").read().strip()
TOKEN = subprocess.run(f"echo -n {MID}9r-cli-auth{SECRET} | sha256sum | cut -c1-16", shell=True, capture_output=True, text=True).stdout.strip()
BASE = "http://127.0.0.1:20128/api/v1/chat/completions"

# provider → model untuk test (harus model yang pasti ada)
TESTS = [
    ("ag/gemini-3.6-flash-medium", "antigravity"),
    ("kr/claude-sonnet-4.5", "kiro"),
    ("kimchi/minimax-m3", "kimchi"),
    ("gcli/grok-4.6", "grok-cli"),
    ("qoder/auto", "qoder"),
]

def test(model, timeout=45):
    payload = json.dumps({"model": model, "messages": [{"role": "user", "content": "say ok"}], "max_tokens": 5, "stream": False})
    try:
        r = subprocess.run(
            ["curl", "-s", "-m", str(timeout), BASE, "-H", f"x-9r-cli-token: {TOKEN}", "-H", "Content-Type: application/json", "-d", payload, "-w", "\n%{http_code}"],
            capture_output=True, text=True, timeout=timeout + 10,
        )
        out = r.stdout
        lines = out.rsplit("\n", 1)
        code = lines[1].strip() if len(lines) > 1 else "000"
        body = lines[0] if len(lines) > 1 else out
        if code == "200":
            try:
                d = json.loads(body)
                content = d.get("choices", [{}])[0].get("message", {}).get("content", "")[:40]
                return True, content
            except Exception:
                return True, body[:40]
        return False, body[:100]
    except Exception as e:
        return False, f"ERR {str(e)[:60]}"

print(f"=== VERIFIKASI PROVIDER ({time.strftime('%H:%M')}) ===")
for model, label in TESTS:
    t0 = time.time()
    ok, info = test(model)
    dt = time.time() - t0
    status = "✅ OK" if ok else "❌ FAIL"
    print(f"{status} {label:<12} {model:<30} {dt:5.1f}s | {info}")
