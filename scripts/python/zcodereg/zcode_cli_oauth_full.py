#!/usr/bin/env python3
"""Full CLI OAuth flow: init -> Camoufox authorize (cookies akun) -> poll -> token."""
import sys, os, json, time, secrets, sqlite3, urllib.request, urllib.error

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"


def load_account(email):
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    conn.close()
    d = json.loads(row[0])
    psd = d.get("providerSpecificData") or {}
    return {"email": email, "cookies": psd.get("cookies", [])}


def inject_cookies(ctx, cookies):
    n = 0
    for c in cookies:
        dom = str(c.get("domain", "")).strip()
        if not dom:
            continue
        try:
            if dom in ("chat.z.ai", "zcode.z.ai", "z.ai", "accounts.google.com", "google.com"):
                ctx.add_cookies([{"name": c["name"], "value": c["value"], "url": "https://" + dom}])
            else:
                ctx.add_cookies([{"name": c["name"], "value": c["value"], "domain": dom.lstrip("."), "path": "/"}])
            n += 1
        except Exception:
            pass
    return n


def init_flow():
    poll_token = secrets.token_hex(32)
    hdrs = {"Content-Type": "application/json", "Authorization": f"Bearer {poll_token}"}
    r = urllib.request.Request("https://zcode.z.ai/api/v1/oauth/cli/init", data=json.dumps({"provider": "zai"}).encode(), headers=hdrs, method="POST")
    with urllib.request.urlopen(r, timeout=25) as resp:
        j = json.loads(resp.read().decode())
    d = j["data"]
    return poll_token, d["flow_id"], d["authorize_url"]


def poll_flow(poll_token, flow_id, tries=90, interval=2):
    url = f"https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}"
    for i in range(tries):
        try:
            r = urllib.request.Request(url, headers={"Authorization": f"Bearer {poll_token}"})
            with urllib.request.urlopen(r, timeout=15) as resp:
                j = json.loads(resp.read().decode())
            st = j.get("data", {}).get("status", "?")
            if st != "pending":
                return j
            if i % 10 == 0:
                print(f"  poll {i}: pending...", flush=True)
        except urllib.error.HTTPError as e:
            print(f"  poll {i}: HTTP {e.code} {e.read().decode()[:150]}", flush=True)
        time.sleep(interval)
    return None


def main():
    email = sys.argv[1] if len(sys.argv) > 1 else "sarah.johnson@e-mail.bty.web.id"
    acc = load_account(email)
    print("email:", email, "| cookies:", len(acc["cookies"]))

    poll_token, flow_id, auth_url = init_flow()
    print("flow_id:", flow_id)
    print("auth_url:", auth_url[:140])

    from camoufox.sync_api import Camoufox
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        print("cookies injected:", inject_cookies(ctx, acc["cookies"]))
        page = ctx.new_page()
        page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        print("url:", page.url[:140])
        # dump semua tombol di consent page
        btns = page.evaluate("""() => [...document.querySelectorAll('button, a')]
            .map(b => ({tag: b.tagName, text: (b.innerText||b.value||'').trim().slice(0,50), id: b.id||'', cls: (b.className||'').slice(0,40)}))
            .filter(b => b.text)""")
        print("buttons:", json.dumps(btns, ensure_ascii=False)[:600])
        # klik tombol approve/authorize/continue (bukan switch)
        clicked = page.evaluate("""() => {
            const btns=[...document.querySelectorAll('button, a')];
            const keywords=['authorize','approve','continue','confirm','allow','同意','授权','允许','登录'];
            for (const k of keywords) {
                const b=btns.find(x=>(x.innerText||'').toLowerCase().includes(k));
                if(b){b.click();return k;}
            }
            return null;
        }""")
        print("clicked:", clicked)
        page.wait_for_timeout(8000)
        print("url after click:", page.url[:140])
        txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,200) : ''")
        print("body:", txt[:200])
        # dump checkbox + semua button lagi
        btns2 = page.evaluate("""() => [...document.querySelectorAll('button, a, input[type=checkbox], label')]
            .map(b => ({tag: b.tagName, text: (b.innerText||b.value||'').trim().slice(0,50), id: b.id||'', type: b.type||''}))
            .filter(b => b.text || b.type)""")
        print("buttons2:", json.dumps(btns2, ensure_ascii=False)[:600])
        # CHECK checkbox ToS dulu (kalau ada) — wajib
        checked = page.evaluate("""() => {
            const cbs=[...document.querySelectorAll('input[type=checkbox]')];
            if (cbs.length) { cbs[0].click(); return true; }
            return false;
        }""")
        print("checkbox checked:", checked)
        page.wait_for_timeout(800)
        # baru klik Continue
        clicked2 = page.evaluate("""() => {
            const btns=[...document.querySelectorAll('button')];
            const b=btns.find(x=>x.innerText.trim().toLowerCase()==='continue');
            if(b){b.click();return true;}
            return false;
        }""")
        print("clicked2:", clicked2)
        page.wait_for_timeout(5000)
        print("url final:", page.url[:160])
        body_full = page.evaluate("() => document.body ? document.body.innerText.slice(0,500) : ''")
        print("body final:", body_full[:500])

    print("=== polling ===")
    res = poll_flow(poll_token, flow_id, tries=45, interval=2)
    if res:
        print("POLL RESULT:", json.dumps(res, ensure_ascii=False)[:800])
        d = res.get("data", {})
        if d.get("status") == "ready":
            with open("/tmp/zcode_oauth_result.json", "w") as f:
                json.dump(d, f)
            print("SAVED /tmp/zcode_oauth_result.json")
    else:
        print("TIMEOUT — no ready")


if __name__ == "__main__":
    main()