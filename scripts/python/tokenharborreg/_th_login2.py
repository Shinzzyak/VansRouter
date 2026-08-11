"""Cek redirect 303 + login dengan akun macanlembayung21."""
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

email = "macanlembayung21@sintec.my.id"
password = "U6jC4MQxkcJ8Th"

# 1. GET login page
r0 = s.get("https://tokenharbor.ai/login", timeout=30)
print("login page:", r0.status_code, len(r0.text))

# extract action id + key dari login page
m = re.search(r'name="\$ACTION_1:0" value="([^"]+)"', r0.text)
key = re.search(r'name="\$ACTION_KEY" value="([^"]+)"', r0.text)
if m and key:
    payload = json.loads(m.group(1).replace("&quot;", '"'))
    action_id = payload.get("id")
    action_key = key.group(1)
    print("action:", action_id, "key:", action_key)

    # 2. POST login dengan hidden fields
    files = {
        "1_email": (None, email),
        "1_password": (None, password),
        "1_next": (None, "0"),
        "0": (None, '["$undefined","$K1"]'),
        "$ACTION_REF_1": (None, ""),
        "$ACTION_1:0": (None, '{"id":"%s","bound":"$@1"}' % action_id),
        "$ACTION_1:1": (None, '["$undefined"]'),
        "$ACTION_KEY": (None, action_key),
    }
    r = s.post(
        "https://tokenharbor.ai/login",
        files=files,
        allow_redirects=False,
        timeout=30,
        headers={"Next-Action": action_id, "Referer": "https://tokenharbor.ai/login"},
    )
    print("login submit:", r.status_code)
    print("Location:", r.headers.get("Location", "NONE"))
    body = r.text[:400]
    print("body:", body)
    m2 = re.search(r'"error":"([^"]+)"', body)
    if m2:
        print("ERROR MSG:", m2.group(1))
else:
    print("action tidak ditemukan di login page")
