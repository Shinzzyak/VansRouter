#!/usr/bin/env python3
"""
Webshare Proxy Farm v2 — Auto-register dengan proxy rotation + valid domains.
Flow: proxy → create email (valerius.biz.id/hzeg.eu.org) → solve reCAPTCHA v2
     → POST register → fetch proxies → append ke webshare_proxies.txt
"""
import json, os, sys, time, random, urllib.request, urllib.error, argparse
from playwright.sync_api import sync_playwright

API_BASE = "https://proxy.webshare.io/api/v2"
RECAPTCHA_SITEKEY = "6LeHZ6UUAAAAAKat_YS--O2tj_by3gv3r_l03j9d"
DOMAINS = ["valerius.biz.id", "hzeg.eu.org"]
PROXIES = [
    "31.59.20.176:6754:wlsnoaoh:i8u8p6ljrw0b",
    "31.56.127.193:7684:wlsnoaoh:i8u8p6ljrw0b",
    "45.38.107.97:6014:wlsnoaoh:i8u8p6ljrw0b",
    "198.105.121.200:6462:wlsnoaoh:i8u8p6ljrw0b",
    "64.137.96.74:6641:wlsnoaoh:i8u8p6ljrw0b",
]

def get_proxy():
    return random.choice(PROXIES)

def create_email():
    """Create random email dengan domain valid."""
    domain = random.choice(DOMAINS)
    username = f"farm{random.randint(1000, 9999)}{random.randint(100, 999)}"
    return f"{username}@{domain}"

def solve_recaptcha_via_browser(email, password, proxy):
    """Solve reCAPTCHA v2 via Camoufox browser."""
    host, port, user, pw = proxy.split(":")
    proxy_url = f"http://{user}:{pw}@{host}:{port}"
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(proxy={"server": proxy_url})
        page = context.new_page()
        
        # Go to register page
        page.goto("https://proxy.webshare.io/register", timeout=30000)
        page.wait_for_timeout(2000)
        
        # Fill form
        page.fill('input[name="email"]', email, timeout=5000)
        page.fill('input[name="password"]', password, timeout=5000)
        page.check('input[name="tos"]')
        
        # Wait for reCAPTCHA
        page.wait_for_selector('iframe[src*="recaptcha"]', timeout=10000)
        page.wait_for_timeout(2000)
        
        # Try to get reCAPTCHA token via JS
        token = page.evaluate("""() => {
            return new Promise((resolve) => {
                const handler = (msg) => {
                    if (msg.data && typeof msg.data === 'string') {
                        window.removeEventListener('message', handler);
                        resolve(msg.data);
                    }
                };
                window.addEventListener('message', handler);
                // Trigger reCAPTCHA
                const iframe = document.querySelector('iframe[src*="recaptcha"]');
                if (iframe) {
                    iframe.contentWindow.postMessage({"action":"execute"},"*");
                }
                setTimeout(() => resolve(null), 15000);
            });
        }""")
        
        if token:
            print(f"    Captcha solved: token len={len(token)}")
        else:
            print(f"    Captcha: no token (manual solve needed)")
            token = "dummy"
        
        browser.close()
    
    return token

def register_account(email, password, recaptcha_token, proxy):
    """POST register to Webshare API."""
    host, port, user, pw = proxy.split(":")
    proxy_url = f"http://{user}:{pw}@{host}:{port}"
    
    proxy_handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    opener = urllib.request.build_opener(proxy_handler)
    
    payload = {
        "email": email,
        "password": password,
        "recaptcha": recaptcha_token,
        "tos_accepted": True,
    }
    
    try:
        req = urllib.request.Request(
            f"{API_BASE}/register/",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}
        )
        r = opener.open(req, timeout=15)
        result = json.loads(r.read())
        return result
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:300]}
    except Exception as e:
        return {"_error": str(e)}

def fetch_proxies(api_token, proxy):
    """GET proxy list from Webshare API."""
    host, port, user, pw = proxy.split(":")
    proxy_url = f"http://{user}:{pw}@{host}:{port}"
    
    proxy_handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    opener = urllib.request.build_opener(proxy_handler)
    
    try:
        req = urllib.request.Request(
            f"{API_BASE}/proxy/list/?mode=direct&page=1&page_size=25",
            headers={"Authorization": f"Token {api_token}"}
        )
        r = opener.open(req, timeout=15)
        result = json.loads(r.read())
        proxies = []
        for p in result.get("results", []):
            host = p.get("proxy_address", "")
            port = p.get("port", "")
            username = p.get("username", "")
            password = p.get("password", "")
            if host and port and username and password:
                proxies.append(f"{host}:{port}:{username}:{password}")
        return proxies
    except Exception as e:
        return []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=3, help="number of accounts")
    ap.add_argument("--output", default="/home/ubuntu/VansRouter/scripts/python/websharereg/proxies_webshare.txt")
    args = ap.parse_args()
    
    print(f"🚀 Webshare Farm v2 — Target: {args.count} accounts")
    print(f"   Domains: {DOMAINS}")
    print(f"   Proxies: {len(PROXIES)} available\n")
    
    results = []
    all_proxies = []
    
    for i in range(1, args.count + 1):
        print(f"=== Account {i}/{args.count} ===")
        
        # Generate email
        email = create_email()
        password = f"Webshare{random.randint(1000, 9999)}!"
        proxy = get_proxy()
        print(f"  Email: {email}")
        print(f"  Proxy: {proxy[:30]}...")
        
        # Solve captcha + register with retry
        print(f"  Solving reCAPTCHA & registering...")
        result = None
        for attempt in range(3):
            try:
                token = solve_recaptcha_via_browser(email, password, proxy)
                result = register_account(email, password, token, proxy)
                if result.get("token"):
                    break
                print(f"    Attempt {attempt+1}: no token, retrying...")
                time.sleep(5)
            except Exception as e:
                if "throttl" in str(e).lower():
                    wait = random.randint(30, 60)
                    print(f"    Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                elif attempt < 2:
                    time.sleep(3)
                else:
                    result = {"_error": str(e)}
        
        if result.get("token"):
            api_token = result["token"]
            print(f"  ✅ REGISTERED: token={api_token[:20]}...")
            
            # Fetch proxies
            print(f"  Fetching proxies...")
            proxies = fetch_proxies(api_token, proxy)
            print(f"  📥 Proxies: {len(proxies)} fetched")
            all_proxies.extend(proxies)
            
            results.append({
                "account": i,
                "email": email,
                "token": api_token,
                "proxies_count": len(proxies),
                "status": "ok"
            })
        else:
            print(f"  ❌ REGISTER FAILED: {result.get('_error', 'unknown')}")
            results.append({
                "account": i,
                "email": email,
                "status": "fail",
                "error": str(result.get('_error', ''))[:100]
            })
        
        # Delay between requests
        time.sleep(random.uniform(2, 5))
    
    # Save results
    with open(args.output, "a") as f:
        if os.path.getsize(args.output) > 0:
            f.write("\n")
        f.write(f"\n# Generated {time.strftime('%Y-%m-%d %H:%M')} by webshare_farm_v2.py\n")
        for p in all_proxies:
            f.write(p + "\n")
    
    print(f"\n=== RESULTS ===")
    print(f"  Success: {len([r for r in results if r['status'] == 'ok'])}/{args.count}")
    print(f"  New proxies: {len(all_proxies)}")
    print(f"  Saved to: {args.output}")
    
    # Save JSON
    with open("/tmp/webshare_farm_v2_results.json", "w") as f:
        json.dump({"total": args.count, "success": len([r for r in results if r['status'] == 'ok']),
                   "results": results, "proxies_count": len(all_proxies)}, f, indent=2)

if __name__ == "__main__":
    main()
