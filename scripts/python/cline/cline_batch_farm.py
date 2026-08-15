#!/usr/bin/env python3
"""Cline batch farm: GSuite → Google SSO → code → decode token → save.
Argumen: start count [list_file]
Output: /tmp/cline_results.tsv (email, status, has_token)
"""
import sys, time, re, json, os, base64, subprocess

def decode_code(code):
    import urllib.parse
    s = code.strip()
    # URL-decode dulu (code bisa URL-encoded)
    s = urllib.parse.unquote(s)
    attempts = []
    # attempt 1: urlsafe b64 + cari JSON
    for variant in ["urlsafe", "standard"]:
        try:
            t = s
            pad = 4 - (len(t) % 4)
            if pad != 4:
                t += "=" * pad
            d = base64.urlsafe_b64decode(t) if variant == "urlsafe" else base64.b64decode(t)
            txt = d.decode("utf-8", errors="replace")
            # cari JSON object pertama (bukan terakhir)
            lb = txt.rfind("}")
            fb = txt.find("{")
            if fb >= 0 and lb > fb:
                try:
                    return json.loads(txt[fb:lb + 1])
                except Exception:
                    attempts.append(f"{variant}:json_fail")
        except Exception as e:
            attempts.append(f"{variant}:{str(e)[:30]}")
    # attempt 2: cari JSON langsung di string (bukan base64)
    fb = s.find("{")
    lb = s.rfind("}")
    if fb >= 0 and lb > fb:
        try:
            return json.loads(s[fb:lb + 1])
        except Exception:
            pass
    # attempt 3: base64 dari segment setelah tanda pemisah
    for sep in [".", "%3D", "="]:
        parts = s.split(sep)
        if len(parts) > 1:
            for p in parts:
                try:
                    t = p
                    pad = 4 - (len(t) % 4)
                    if pad != 4:
                        t += "=" * pad
                    d = base64.urlsafe_b64decode(t)
                    txt = d.decode("utf-8", errors="replace")
                    fb, lb = txt.find("{"), txt.rfind("}")
                    if fb >= 0 and lb > fb:
                        return json.loads(txt[fb:lb + 1])
                except Exception:
                    continue
    return None

def run_one(email, pw, idx):
    sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
    from camoufox import Camoufox

    AUTH_URL = "https://api.cline.bot/api/v1/auth/authorize?client_type=web"
    try:
        with Camoufox(headless=False) as browser:
            page = browser.new_page()
            page.goto(AUTH_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(7000)
            clicked = False
            for sel in ["button:has-text('Google')", "a:has-text('Google')", "text=Continue with Google", "[class*=google]"]:
                try:
                    el = page.wait_for_selector(sel, timeout=9000)
                    if el:
                        el.click()
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                return "no_google_btn"
            page.wait_for_timeout(7000)
            try:
                page.wait_for_selector("#identifierId", timeout=18000)
                page.fill("#identifierId", email)
                page.keyboard.press("Enter")
                page.wait_for_timeout(2500)
                page.wait_for_selector("input[type=password]", timeout=15000)
                page.fill("input[type=password]", pw)
                page.keyboard.press("Enter")
            except Exception:
                return "login_err"
            code = None
            for i in range(55):
                page.wait_for_timeout(1000)
                u = page.url
                if "oauth/id" in u or "oauth/v2" in u:
                    for sel in ["button:has-text('Continue')", "button:has-text('Lanjutkan')", "button[jsname=LgbsSe]", "#accept"]:
                        try:
                            b = page.locator(sel).first
                            if b.count():
                                b.click(timeout=800)
                                page.wait_for_timeout(1200)
                        except Exception:
                            pass
                m = re.search(r"[?&]code=([^&]+)", u)
                if m and "cline.bot" in u:
                    code = m.group(1)
                    break
                if i % 15 == 0:
                    print(f"[{idx}] T{i}: {u[:70]}", flush=True)
            if not code:
                return "no_code"
            tok = decode_code(code)
            if not tok:
                return "decode_err"
            os.makedirs("/tmp/cline_tokens", exist_ok=True)
            fname = f"/tmp/cline_tokens/{email.replace('@','_')}.json"
            json.dump(tok, open(fname, "w"), indent=1)
            return "ok"
    except Exception as e:
        return f"exc:{str(e)[:60]}"

def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    list_file = sys.argv[3] if len(sys.argv) > 3 else None
    if list_file:
        emails = [l.strip() for l in open(list_file) if l.strip()]
    else:
        emails = []
        for l in open("/home/ubuntu/Avres Second Brain/Avres Second Brain/VansRouter/gsuite-bty-110-accounts.txt"):
            parts = l.strip().split("|")
            if len(parts) >= 2 and "@" in parts[0]:
                emails.append((parts[0].strip(), parts[1].strip()))
    results = []
    for i in range(start, min(start + count, len(emails))):
        entry = emails[i]
        email = entry[0] if isinstance(entry, tuple) else entry
        pw = entry[1] if isinstance(entry, tuple) else ""
        status = run_one(email, pw, i)
        results.append((email, status))
        print(f"[{i}] {email} => {status}", flush=True)
        with open("/tmp/cline_results.tsv", "a") as f:
            f.write(f"{email}\t{status}\n")
    ok = sum(1 for _, s in results if s == "ok")
    print(f"=== DONE {ok}/{len(results)} ===")

if __name__ == "__main__":
    main()
