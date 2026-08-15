#!/usr/bin/env python3
"""Cast AI (kimchi) batch v2 — Playwright Firefox (terbukti) + nama token unik.
Flow: console.cast.ai/sign-up → Google SSO → POST /api/v1/auth/tokens → castai_v1_* key.
"""
import sys, time, json, re, os, subprocess, uuid

ACCOUNTS_FILE = "/home/ubuntu/Avres Second Brain/Avres Second Brain/VansRouter/gsuite-bty-110-accounts.txt"
OUT_FILE = "/tmp/cast_results.tsv"

SCRIPT_TEMPLATE = r'''import sys, time, json, re
from playwright.sync_api import sync_playwright

EMAIL = "__EMAIL__"
PASS = "__PASS__"
NAME = "router-__RAND__"

def click_text(page, pattern, tries=3, wait=2):
    for i in range(tries):
        for sel in ["button", "a", "[role=button]", "input[type=submit]"]:
            for el in page.locator(sel).all():
                try:
                    t = (el.inner_text() or "").strip()
                except Exception:
                    continue
                if re.search(pattern, t, re.I):
                    try:
                        el.click(timeout=3000)
                        return True
                    except Exception:
                        pass
        time.sleep(wait)
    return False

with sync_playwright() as p:
    browser = p.firefox.launch(headless=False)
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto("https://console.cast.ai/sign-up", timeout=45000, wait_until="domcontentloaded")
    time.sleep(5)
    click_text(page, r"reject|accept all", tries=2)
    click_text(page, r"^google$", tries=3)
    time.sleep(6)
    page.wait_for_selector("#identifierId", timeout=20000)
    page.fill("#identifierId", EMAIL)
    page.keyboard.press("Enter")
    time.sleep(6)
    page.wait_for_selector("input[type=password]", timeout=20000)
    page.fill("input[type=password]", PASS)
    page.keyboard.press("Enter")
    time.sleep(8)
    click_text(page, r"lanjutkan|continue|同意|继续", tries=4)
    time.sleep(12)
    print("AFTER_LOGIN:", page.url, flush=True)
    if "console.cast.ai" not in page.url:
        print("LOGIN_FAILED", flush=True)
        sys.exit(1)
    # speedbump workspaces TOS
    click_text(page, r"i understand|understand", tries=3)
    time.sleep(3)
    r = page.evaluate("""async (n) => {
        const resp = await fetch('https://console.cast.ai/api/v1/auth/tokens', {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: n})
        });
        return {status: resp.status, body: (await resp.text()).slice(0, 2000)};
    }""", NAME)
    print("CREATE:", json.dumps(r), flush=True)
    if r["status"] == 200 or r["status"] == 201:
        try:
            d = json.loads(r["body"])
            key = d.get("token", d.get("apiKey", d.get("value", "")))
            if key:
                print("KEY:", key, flush=True)
                sys.exit(0)
        except Exception:
            pass
    # fallback: list tokens
    r = page.evaluate("""async () => {
        const resp = await fetch('https://console.cast.ai/api/v1/auth/tokens', {credentials: 'include'});
        return {status: resp.status, body: (await resp.text()).slice(0, 2000)};
    }""")
    print("LIST:", json.dumps(r), flush=True)
    browser.close()
    sys.exit(1)
'''

def run_one(email, pw, idx):
    script = SCRIPT_TEMPLATE.replace("__EMAIL__", email).replace("__PASS__", pw.replace("\\", "\\\\").replace('"', '\\"')).replace("__RAND__", str(uuid.uuid4().hex[:8]))
    path = f"/tmp/cast_run_{os.getpid()}_{idx}.py"
    with open(path, "w") as f:
        f.write(script)
    try:
        r = subprocess.run(
            ["/home/ubuntu/camoufox-env/bin/python", path],
            capture_output=True, text=True, timeout=240,
            env={**os.environ, "DISPLAY": ":99"},
        )
        log = r.stdout + r.stderr
        key = ""
        for line in log.split("\n"):
            if line.startswith("KEY:"):
                key = line[4:].strip()
        return key, log
    except subprocess.TimeoutExpired:
        return "", "TIMEOUT"
    finally:
        try:
            os.remove(path)
        except Exception:
            pass

def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    accs = []
    for l in open(ACCOUNTS_FILE):
        parts = l.strip().split("|")
        if len(parts) >= 2:
            accs.append((parts[0].strip(), parts[1].strip()))
    results = []
    for i in range(start, min(start + count, len(accs))):
        email, pw = accs[i]
        print(f"[{i}] {email} ...", flush=True)
        key, log = run_one(email, pw, i)
        if key:
            results.append(f"{email}\tok\t{key}")
            print(f"  -> ok ({key[:20]}...)", flush=True)
        else:
            tail = log.strip().split("\n")[-1] if log else ""
            results.append(f"{email}\tfail\t{tail[:100]}")
            print(f"  -> fail: {tail[:100]}", flush=True)
        os.system("pkill -9 -f firefox 2>/dev/null")
        time.sleep(1)
    with open(OUT_FILE, "w") as f:
        f.write("\n".join(results) + "\n")
    print(f"=== DONE {sum(1 for r in results if chr(9)+'ok'+chr(9) in r)}/{len(results)} ===", flush=True)

if __name__ == "__main__":
    main()
