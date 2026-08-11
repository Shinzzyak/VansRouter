"""Cek API referral/invite TokenHarbor dengan auth token Supabase."""
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

# login
r0 = s.get("https://tokenharbor.ai/login", timeout=30)
m = re.search(r'name="\$ACTION_1:0" value="([^"]+)"', r0.text)
key = re.search(r'name="\$ACTION_KEY" value="([^"]+)"', r0.text)
payload = json.loads(m.group(1).replace("&quot;", '"'))
action_id = payload.get("id")
action_key = key.group(1)
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
r = s.post("https://tokenharbor.ai/login", files=files, allow_redirects=False, timeout=30,
           headers={"Next-Action": action_id, "Referer": "https://tokenharbor.ai/login"})
print("login:", r.status_code)

# ambil access token dari cookie
auth_cookie = s.cookies.get("sb-auth-auth-token.0", "")
print("auth cookie len:", len(auth_cookie))
# decode base64
import base64
try:
    decoded = base64.b64decode(auth_cookie + "==").decode()
    data = json.loads(decoded)
    access_token = data.get("access_token", "")
    print("access_token len:", len(access_token))
    print("user id:", data.get("user", {}).get("id", "?"))
except Exception as e:
    print("decode err:", e)
    access_token = ""

# cek halaman-halaman yang mungkin punya referral
for path in ["/dashboard", "/dashboard/referral", "/dashboard/invite", "/referral", "/invite", "/dashboard/settings"]:
    try:
        r2 = s.get("https://tokenharbor.ai" + path, timeout=20)
        inv = re.findall(r"TH-[A-Z0-9]{4}-[A-Z0-9]{4}", r2.text)
        print(f"{path}: {r2.status_code} len={len(r2.text)} invite={set(inv) if inv else 'none'}")
    except Exception as e:
        print(f"{path}: ERR {type(e).__name__}")

# cek API endpoint umum
if access_token:
    for ep in [
        "https://tokenharbor.ai/api/user/referral",
        "https://tokenharbor.ai/api/referral",
        "https://tokenharbor.ai/api/invite",
        "https://tokenharbor.ai/api/user/invite-code",
        "https://tokenharbor.ai/api/auth/user",
    ]:
        try:
            r3 = s.get(ep, timeout=15, headers={"Authorization": f"Bearer {access_token}"})
            print(f"API {ep}: {r3.status_code} {r3.text[:150]}")
        except Exception as e:
            print(f"API {ep}: ERR {type(e).__name__}")
