#!/usr/bin/env python3
"""E2E v3: browser pre-warmed BEFORE agy spawn; login sequence minimal-wait."""
import sys, time, re, subprocess, threading, json, os
sys.path.insert(0, "/home/ubuntu/x-farm")
from camoufox import Camoufox

WARP = "http://127.0.0.1:40000"
EMAIL, PASSWORD = sys.argv[1], sys.argv[2]
os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"

code_result = {"code": ""}
auth_url_holder = {}

# pre-warm browser in background thread
def warm_browser():
    with Camoufox(headless=True, proxy={"server": WARP}, geoip=True) as browser:
        page = browser.new_page()
        code_result["browser"] = (browser, page)
        while not auth_url_holder.get("url"):
            time.sleep(0.3)
        url = auth_url_holder["url"]
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#identifierId", timeout=45000)
        page.fill("#identifierId", EMAIL)
        page.keyboard.press("Enter")
        page.wait_for_timeout(1800)
        page.wait_for_selector('input[type="password"]', timeout=25000)
        page.fill('input[type="password"]', PASSWORD)
        page.keyboard.press("Enter")
        page.wait_for_timeout(1800)
        for i in range(30):
            page.wait_for_timeout(600)
            if "nativeapp" in page.url:
                break
        for txt in ["Login", "Sign in", "Masuk", "Log in", "Continue", "Lanjut"]:
            try:
                b = page.get_by_role("button", name=re.compile(rf"^{txt}$", re.I))
                if b.count():
                    b.first.click(timeout=1500)
                    break
            except Exception:
                pass
        for i in range(25):
            page.wait_for_timeout(600)
            body = page.evaluate("document.body ? document.body.innerText : ''")
            m = re.search(r"4/0[A-Za-z0-9_\-/]+", body)
            if m:
                code_result["code"] = m.group(0)
                return

tw = threading.Thread(target=warm_browser)
tw.start()
# wait for browser ready
while "browser" not in code_result:
    time.sleep(0.3)

proc = subprocess.Popen(
    ["script", "-qec", "/home/ubuntu/.local/bin/agy -p 'say OK' --output-format json", "/dev/null"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    bufsize=1,
)
deadline = time.time() + 40
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        break
    line = line.strip()
    print("AGY:", line[:90], flush=True)
    m = re.search(r"https://accounts\.google\.com/o/oauth2/auth\S+", line)
    if m:
        auth_url_holder["url"] = m.group(0)
        break

if not auth_url_holder.get("url"):
    print("NO_AUTH_URL"); proc.kill(); sys.exit(1)
print("URL -> BROWSER", flush=True)

tw.join(timeout=100)
code = code_result.get("code", "")
if code:
    print("GOT_CODE", len(code), flush=True)
    try:
        proc.stdin.write(code + "\n")
        proc.stdin.flush()
        out = proc.stdout.read(3000)
        print("AGY_FINAL:", out[-2200:], flush=True)
    except BrokenPipeError:
        print("PIPE_CLOSED_AGAIN", flush=True)
else:
    print("NO_CODE", flush=True)
    proc.kill()
proc.wait(timeout=10)
