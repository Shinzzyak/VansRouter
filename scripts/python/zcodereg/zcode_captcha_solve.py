#!/usr/bin/env python3
"""Claim plan dengan captcha Aliyun solve via Camoufox (in-page).
Scene: no8xfe / sceneId 11xygtvd (dari configs). Solver: zai_slider.solve_slider_v2
"""
import sys, os, json, time, uuid, sqlite3, urllib.parse, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
PLAN_ID = "zcode-v3-start-plan-0828"
APP_VERSION = "3.10.0"
PLATFORM = "win32-x64"


def load_jwt(email):
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?", (email,)).fetchone()
    conn.close()
    if not row:
        return None, None, None
    d = json.loads(row[0])
    psd = d.get("providerSpecificData") or {}
    return d.get("accessToken", ""), psd.get("zcodeJwtToken", ""), psd.get("cookies", [])


def req(method, url, body=None, auth=None, extra=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if auth: h["Authorization"] = f"Bearer {auth}"
    if extra: h.update(extra)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="ignore")


def solve_captcha_email(email):
    """Solve Aliyun captcha in a Camoufox browser with zcode cookies, return verifyParam."""
    from camoufox.sync_api import Camoufox
    from zai_slider import solve_slider_v2
    at, jwt, cookies = load_jwt(email)
    print(f"[captcha] {email} jwt={len(jwt)}")
    with Camoufox(headless=True) as browser:
        ctx = browser.new_context()
        # inject cookies zcode + z.ai
        n = 0
        for c in cookies:
            dom = str(c.get("domain", "")).strip()
            if not dom or "z.ai" not in dom and "zcode" not in dom:
                continue
            ck = {"name": c["name"], "value": c["value"]}
            if dom in ("chat.z.ai", "zcode.z.ai", "z.ai"):
                ck["url"] = "https://" + dom
            else:
                ck["domain"] = dom if dom.startswith(".") else "." + dom.lstrip(".")
                ck["path"] = "/"
            try:
                ctx.add_cookies([ck]); n += 1
            except Exception:
                pass
        print(f"[captcha] cookies injected: {n}")
        page = ctx.new_page()
        # mount captcha widget (zcode.z.ai sceneId 11xygtvd dari configs API)
        page.goto("https://zcode.z.ai", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        # load aliyun captcha SDK manual (dari bundle: region sgp prefix no8xfe)
        page.evaluate("""async () => {
            if (typeof window.initAliyunCaptcha === 'function') return;
            const s = document.createElement('script');
            s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
            document.head.appendChild(s);
            await new Promise((r) => {
                s.onload = r; s.onerror = () => r();
                setTimeout(r, 10000);
            });
        }""")
        page.wait_for_timeout(3000)
        # mount element widget
        page.evaluate("""() => {
            const el = document.createElement('div');
            el.id = 'aliyun-captcha'; el.style.cssText = 'position:fixed;z-index:99999;top:100px;left:100px;width:320px';
            const btn = document.createElement('div');
            btn.id = 'aliyun-captcha-btn'; btn.style.cssText = 'width:200px;height:40px;border:1px solid #333;text-align:center;line-height:40px;cursor:pointer;background:#f0f0f0;font-size:13px';
            btn.textContent = 'Verify';
            el.appendChild(btn);
            document.body.appendChild(el);
            window.__capBtn = btn;
        }""")
        result = page.evaluate("""() => {
            return new Promise((resolve) => {
                if (typeof window.initAliyunCaptcha !== 'function') { resolve({err: 'no initAliyunCaptcha after load'}); return; }
                try {
                    let instanceRef = null;
                    window.__capInstance = null;
                    const cfg = {SceneId: '11xygtvd', prefix: 'no8xfe', region: 'sgp', mode: 'embed',
                        element: '#aliyun-captcha', button: '#aliyun-captcha-btn',
                        language: 'en', width: '320px',
                        getInstance: (instance) => {
                            instanceRef = instance;
                            window.__capInstance = instance;
                            instance.onSuccess = (v) => resolve({ok: true, verifyParam: (v && (v.verifyParam || v.captchaVerifyParam)) || JSON.stringify(v)});
                            instance.onError = (e) => resolve({err: 'captcha error ' + JSON.stringify(e)});
                            instance.onClose = () => resolve({err: 'closed'});
                            // trigger
                            document.getElementById('aliyun-captcha-btn').click();
                            // TRACELESS: panggil langsung (risk-engine, tanpa UI slide)
                            setTimeout(() => {
                                try {
                                    if (instance.startTracelessVerification) {
                                        instance.startTracelessVerification();
                                    }
                                } catch(e) { console.log('traceless err', e); }
                            }, 800);
                        }};
                    window.initAliyunCaptcha(cfg);
                    setTimeout(() => resolve({err: 'timeout', hasInst: !!instanceRef}), 90000);
                } catch(e) { resolve({err: 'init ' + e.message}); }
            });
        }""")
        print("[captcha] result:", json.dumps(result)[:400])
        if result.get("err") == "timeout":
            # coba drag slider: cari elemen aliyunCaptcha-sliding-slider / puzzle
            slider_info = page.evaluate("""() => {
                const q = (sel) => document.querySelector(sel);
                const info = {};
                for (const sel of ['#aliyunCaptcha-img','.aliyunCaptcha-img','#aliyunCaptcha-puzzle','.aliyunCaptcha-puzzle',
                                   '#aliyunCaptcha-sliding-slider','.aliyunCaptcha-slide','[class*=aliyunCaptcha]',
                                   '[class*=sliding-slider]','iframe']) {
                    const el = q(sel);
                    if (el) {
                        const r = el.getBoundingClientRect();
                        info[sel] = {tag: el.tagName, cls: (el.className||'').slice(0,80), x: r.x, y: r.y, w: r.width, h: r.height, src: (el.src||'').slice(0,80)};
                    }
                }
                const iframes = [...document.querySelectorAll('iframe')].map(f=>({src: f.src.slice(0,120), x: f.getBoundingClientRect().x, y: f.getBoundingClientRect().y, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height}));
                info.iframes = iframes;
                return info;
            }""")
            print("[captcha] slider info:", json.dumps(slider_info)[:1200])
            # kalau ada iframe captcha, mungkin di dalam iframe — print semua iframe
        return result


if __name__ == "__main__":
    email = sys.argv[1] if len(sys.argv) > 1 else "ruth.hernandez@e-mail.bty.web.id"
    r = solve_captcha_email(email)
    print("FINAL:", json.dumps(r)[:500])