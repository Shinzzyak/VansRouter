#!/usr/bin/env python3
"""AI Studio (Gemini API key) batch: GSuite → aistudio.google.com → create API key."""
import sys, time, re, subprocess, json, os

def run_one(email, pw, idx):
    sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
    from camoufox import Camoufox

    key_result = {"key": ""}
    with Camoufox(headless=False) as browser:
        page = browser.new_page()
        # intercept response utk tangkap API key
        def on_resp(r):
            try:
                if "/apikeys" in r.url or "apikey" in r.url.lower():
                    if r.status < 300:
                        body = r.text()
                        if body and "key" in body.lower()[:2000]:
                            m = re.search(r'"key"\s*:\s*"([^"]+)"', body)
                            if m:
                                key_result["key"] = m.group(1)
            except Exception:
                pass
        page.on("response", on_resp)
        page.goto("https://aistudio.google.com/app/apikey", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        # login
        try:
            page.wait_for_selector("#identifierId", timeout=30000)
            page.fill("#identifierId", email)
            page.keyboard.press("Enter")
            page.wait_for_timeout(3000)
            page.wait_for_selector("input[type=password]", timeout=20000)
            page.fill("input[type=password]", pw)
            page.keyboard.press("Enter")
            page.wait_for_timeout(5000)
        except Exception as e:
            print("LOGIN_ERR:", str(e)[:80], flush=True)
        # consent/nativeapp
        for i in range(30):
            page.wait_for_timeout(1000)
            u = page.url
            if "nativeapp" in u:
                for txt in ["Login", "Sign in", "Masuk", "Continue", "Lanjutkan"]:
                    try:
                        b = page.get_by_role("button", name=re.compile(r"^" + txt + "$", re.I))
                        if b.count():
                            b.first.click(timeout=1000)
                            break
                    except Exception:
                        pass
            else:
                for txt in ["Continue", "Lanjutkan", "同意", "I understand"]:
                    try:
                        b = page.get_by_role("button", name=re.compile(r"^" + txt + "$", re.I))
                        if b.count():
                            b.first.click(timeout=1000)
                    except Exception:
                        pass
            if "aistudio.google.com" in u and "signin" not in u:
                break
        page.wait_for_timeout(5000)
        print("URL:", page.url[:120], flush=True)
        if "aistudio.google.com/app/apikey" not in page.url:
            page.goto("https://aistudio.google.com/app/apikey", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
        print("URL2:", page.url[:120], flush=True)
        # klik Create API key
        clicked = False
        for sel in ["button:has-text('Create API key')", "button:has-text('Create API Key')", "button:has-text('Create')"]:
            try:
                btn = page.wait_for_selector(sel, timeout=8000)
                if btn:
                    btn.click()
                    clicked = True
                    print("CLICKED:", sel, flush=True)
                    break
            except Exception:
                continue
        if not clicked:
            # coba link
            for sel in ["a:has-text('Create API key')", "a:has-text('Create API Key')"]:
                try:
                    el = page.wait_for_selector(sel, timeout=5000)
                    if el:
                        el.click()
                        clicked = True
                        break
                except Exception:
                    continue
        page.wait_for_timeout(6000)
        # dialog: pilih project → buat
        for sel in ["button:has-text('Create API key')", "button:has-text('Create API Key')", "button:has-text('Create in new project')"]:
            try:
                btn = page.wait_for_selector(sel, timeout=5000)
                if btn:
                    btn.click()
                    print("DIALOG:", sel, flush=True)
                    break
            except Exception:
                continue
        page.wait_for_timeout(8000)
        # cek key muncul
        try:
            key_el = page.wait_for_selector("text=AIza", timeout=15000)
            if key_el:
                txt = page.evaluate("() => document.body.innerText")
                m = re.search(r"(AIza[0-9A-Za-z_\-]{20,})", txt)
                if m:
                    key_result["key"] = m.group(1)
                    print("KEY:", m.group(1)[:25], flush=True)
        except Exception:
            pass
        # dump body text utk debug
        try:
            txt = page.evaluate("() => document.body.innerText")
            ai = re.search(r"(AIza[0-9A-Za-z_\-]{20,})", txt)
            if ai and not key_result["key"]:
                key_result["key"] = ai.group(1)
                print("KEY2:", ai.group(1)[:25], flush=True)
        except Exception:
            pass
        if not key_result["key"]:
            print("NO_KEY", flush=True)
        # save
        if key_result["key"]:
            os.makedirs("/tmp/gemini_keys", exist_ok=True)
            fname = email.replace("@", "_") + ".json"
            json.dump({"email": email, "apiKey": key_result["key"]}, open(f"/tmp/gemini_keys/{fname}", "w"), indent=1)
            print("SAVED", fname, flush=True)
    return key_result["key"]

if __name__ == "__main__":
    email, pw = sys.argv[1], sys.argv[2]
    k = run_one(email, pw, 0)
    print("RESULT:", "ok" if k else "fail")
