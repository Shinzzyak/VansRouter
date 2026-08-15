#!/usr/bin/env python3
"""Kimi device flow batch — GSuite → google login → approve device → token.
Flow: device_authorization → browser authorize_device (paste user_code) → Google login → approve → poll token.
"""
import sys, time, re, json, os, urllib.request, urllib.error

CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
DEVICE_URL = "https://auth.kimi.com/api/oauth/device_authorization"
TOKEN_URL = "https://auth.kimi.com/api/oauth/token"
AUTH_PAGE = "https://www.kimi.com/code/authorize_device"

def device_code():
    body = f"client_id={CLIENT_ID}".encode()
    req = urllib.request.Request(DEVICE_URL, data=body, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def poll_token(device_code_val, interval=3, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = f"client_id={CLIENT_ID}&device_code={device_code_val}&grant_type=urn:ietf:params:oauth:grant-type:device_code".encode()
        req = urllib.request.Request(TOKEN_URL, data=body, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            if "authorization_pending" in err:
                time.sleep(interval)
                continue
            if "slow_down" in err:
                interval += 1
                time.sleep(interval)
                continue
            return {"error": err[:200]}
    return {"error": "timeout"}

def run_one(email, pw):
    sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
    from camoufox import Camoufox

    dc = device_code()
    user_code = dc.get("user_code", "")
    device_code_val = dc.get("device_code", "")
    print(f"user_code: {user_code}", flush=True)

    with Camoufox(headless=False) as browser:
        page = browser.new_page()
        page.goto(AUTH_PAGE, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        print("URL1:", page.url[:100], flush=True)
        # input user_code
        try:
            inp = page.wait_for_selector("input", timeout=15000)
            if inp:
                inp.fill(user_code)
                page.keyboard.press("Enter")
                print("CODE_ENTERED", flush=True)
        except Exception as e:
            print(f"NO_INPUT: {str(e)[:80]}", flush=True)
        page.wait_for_timeout(6000)
        # login form Kimi: email (tel/text input) + password + Log In
        try:
            # input email — cari input bukan password
            inp_email = page.wait_for_selector("input[type=tel], input[type=text]:not([type=password])", timeout=10000)
            if inp_email:
                inp_email.fill(email)
                print("EMAIL_FILLED", flush=True)
            page.wait_for_timeout(1500)
            # mungkin ada tombol Send / Continue dulu
            for txt in ["Send", "Continue", "Next", "下一步"]:
                try:
                    b = page.get_by_role("button", name=re.compile("^" + txt + "$", re.I))
                    if b.count():
                        b.first.click(timeout=1000)
                        print("NEXT:", txt, flush=True)
                        page.wait_for_timeout(2000)
                        break
                except Exception:
                    pass
            inp_pass = page.wait_for_selector("input[type=password]", timeout=10000)
            if inp_pass:
                inp_pass.fill(pw)
                print("PASS_FILLED", flush=True)
            page.wait_for_timeout(1000)
            for txt in ["Log In", "Login", "Sign in", "登录", "确认"]:
                try:
                    b = page.get_by_role("button", name=re.compile("^" + txt + "$", re.I))
                    if b.count():
                        b.first.click(timeout=1000)
                        print("LOGIN_CLICK:", txt, flush=True)
                        break
                except Exception:
                    pass
        except Exception as e:
            print(f"LOGIN_ERR: {str(e)[:80]}", flush=True)
        page.wait_for_timeout(8000)
        # approve/authorize
        for i in range(20):
            page.wait_for_timeout(1000)
            u = page.url
            for txt in ["Allow", "Approve", "Confirm", "Authorize", "同意", "确认", "允许", "Log In", "Login"]:
                try:
                    b = page.get_by_role("button", name=re.compile("^" + txt + "$", re.I))
                    if b.count():
                        b.first.click(timeout=1000)
                        print("APPROVE:", txt, flush=True)
                except Exception:
                    pass
            if i % 5 == 0:
                print(f"T{i}: {u[:90]}", flush=True)

    # poll token
    tok = poll_token(device_code_val)
    print("TOKEN_RESULT:", json.dumps({k: (v[:30] if isinstance(v, str) else v) for k, v in tok.items()})[:300], flush=True)
    if tok.get("access_token") or tok.get("refresh_token"):
        os.makedirs("/tmp/kimi_tokens", exist_ok=True)
        fname = email.replace("@", "_") + ".json"
        json.dump(tok, open(f"/tmp/kimi_tokens/{fname}", "w"), indent=1)
        print("SAVED", fname, flush=True)
        return tok
    return None

if __name__ == "__main__":
    email, pw = sys.argv[1], sys.argv[2]
    t = run_one(email, pw)
    print("RESULT:", "ok" if t else "fail")
