"""Coba login ke TokenHarbor dengan akun yang baru dibuat via IP HP."""
import sys, uuid, time, json, re
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
import requests, urllib3
urllib3.disable_warnings()

proxy = "socks5://127.0.0.1:1080"
s = requests.Session()
s.proxies = {"http": proxy, "https": proxy}
s.verify = False
s.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/x-component",
})

email = "thhp1786450865@sintec.my.id"
password = "@2qwJcMJsB5Nw8"

# 1. GET login page
r0 = s.get("https://tokenharbor.ai/login", timeout=30)
print("login page:", r0.status_code, len(r0.text))

# cari action id di halaman login
m = re.search(r'name="Next-Action" value="([^"]+)"', r0.text)
if not m:
    m = re.search(r'"actionId":"([^"]+)"', r0.text)
if not m:
    m = re.search(r'([a-f0-9]{40})', r0.text)
action_id = m.group(1) if m else None
print("action:", action_id)

if action_id:
    # 2. POST login
    files = {
        "1_email": (None, email),
        "1_password": (None, password),
        "1_next": (None, "0"),
        "0": (None, '["$undefined","$K1"]'),
    }
    r = s.post(
        "https://tokenharbor.ai/login",
        files=files,
        allow_redirects=False,
        timeout=30,
        headers={"Next-Action": action_id, "Referer": "https://tokenharbor.ai/login"},
    )
    print("login submit:", r.status_code)
    body = r.text[:600]
    print("body:", body)
    m2 = re.search(r'"error":"([^"]+)"', body)
    if m2:
        print("ERROR MSG:", m2.group(1))
    if r.status_code == 303 or "Location" in str(r.headers):
        print("REDIRECT:", r.headers.get("Location"))
