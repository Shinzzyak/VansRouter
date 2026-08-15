#!/usr/bin/env python3
"""Gemini-CLI batch auth: GSuite → Google OAuth → refresh token + projectId.
Flow sama seperti AG (agy) tapi client id gemini-cli + scope cloud-platform.
"""
import sys, time, re, subprocess, threading, json, os

CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
CLIENT_SECRET = "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"
SCOPES = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"
REDIRECT = "http://localhost:8080/callback"

AUTH_URL = (
    "https://accounts.google.com/o/oauth2/v2/auth"
    f"?client_id={CLIENT_ID}&response_type=code&redirect_uri={REDIRECT}"
    f"&scope={SCOPES.replace(' ', '%20')}&access_type=offline&prompt=consent"
)

def run_one(email, pw):
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
    sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
    from camoufox import Camoufox

    code_result = {"code": ""}

    def browser_flow():
        try:
            with Camoufox(headless=False) as browser:
                page = browser.new_page()
                page.goto(AUTH_URL, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(4000)
                page.wait_for_selector("#identifierId", timeout=45000)
                page.fill("#identifierId", email)
                page.keyboard.press("Enter")
                page.wait_for_timeout(1800)
                page.wait_for_selector('input[type="password"]', timeout=25000)
                page.fill('input[type="password"]', pw)
                page.keyboard.press("Enter")
                page.wait_for_timeout(1800)
                # speedbump
                for i in range(20):
                    page.wait_for_timeout(600)
                    if "speedbump" in page.url or "workspacetermsofservice" in page.url:
                        try:
                            btn = page.get_by_role("button", name=re.compile(r"^I understand$", re.I))
                            if btn.count():
                                btn.first.click(timeout=1500)
                        except Exception:
                            pass
                    # consent
                    for txt in ["Continue", "Lanjutkan", "同意", "繼續"]:
                        try:
                            b = page.get_by_role("button", name=re.compile(rf"^{txt}$", re.I))
                            if b.count():
                                b.first.click(timeout=1200)
                        except Exception:
                            pass
                    # nativeapp → klik Login
                    if "nativeapp" in page.url:
                        for txt in ["Login", "Sign in", "Masuk", "Log in", "Continue", "Lanjutkan", "同意", "繼續"]:
                            try:
                                b = page.get_by_role("button", name=re.compile(rf"^{txt}$", re.I))
                                if b.count():
                                    b.first.click(timeout=1200)
                            except Exception:
                                pass
                    # cek redirect ke localhost dengan code
                    if "localhost:8080/callback" in page.url or "code=" in page.url:
                        m = re.search(r"[?&]code=([^&]+)", page.url)
                        if m:
                            code_result["code"] = m.group(1)
                            return
                # last check
                m = re.search(r"[?&]code=([^&]+)", page.url)
                if m:
                    code_result["code"] = m.group(1)
        except Exception as e:
            code_result["error"] = str(e)[:200]

    t = threading.Thread(target=browser_flow)
    t.start()
    deadline = time.time() + 180
    while time.time() < deadline and not code_result.get("code") and not code_result.get("error"):
        time.sleep(0.5)
    t.join(timeout=5)

    code = code_result.get("code", "")
    if not code:
        return {"status": "fail", "error": code_result.get("error", "NO_CODE")[:120]}

    # exchange code → tokens
    r = subprocess.run(
        ["curl", "-s", "-m", "20", "https://oauth2.googleapis.com/token",
         "-d", f"grant_type=authorization_code&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&code={code}&redirect_uri={REDIRECT}"],
        capture_output=True, text=True, timeout=30,
    )
    try:
        tokens = json.loads(r.stdout)
    except Exception:
        return {"status": "fail", "error": f"EXCHANGE_ERR: {r.stdout[:150]}"}
    if "refresh_token" not in tokens:
        return {"status": "fail", "error": f"NO_RT: {json.dumps(tokens)[:200]}"}

    at = tokens.get("access_token", "")
    rt = tokens.get("refresh_token", "")

    # loadCodeAssist → projectId + tier
    proj = ""
    tier = ""
    try:
        r2 = subprocess.run(
            ["curl", "-s", "-m", "20", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
             "-H", f"Authorization: Bearer {at}",
             "-H", "User-Agent: gemini-cli/0.34.0",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"metadata": {"ideType": 3, "platform": 3, "pluginType": 2}, "mode": 1})],
            capture_output=True, text=True, timeout=30,
        )
        d = json.loads(r2.stdout)
        proj = d.get("cloudaicompanionProject", "")
        if isinstance(proj, dict):
            proj = proj.get("id", "")
        tier = d.get("currentTier", {}).get("id", "")
    except Exception as e:
        pass

    return {"status": "ok", "email": email, "refreshToken": rt, "accessToken": at, "projectId": proj, "tier": tier}

if __name__ == "__main__":
    email, pw = sys.argv[1], sys.argv[2]
    res = run_one(email, pw)
    print(json.dumps(res))
    if res["status"] == "ok":
        # save token
        os.makedirs("/tmp/gc_tokens", exist_ok=True)
        fname = email.replace("@", "_") + ".json"
        json.dump({"token": {"access_token": res.get("accessToken"), "refresh_token": res.get("refreshToken")}, "projectId": res.get("projectId"), "tier": res.get("tier")}, open(f"/tmp/gc_tokens/{fname}", "w"), indent=1)
        print("SAVED", fname)
