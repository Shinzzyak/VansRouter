"""Decode cookie Supabase + cari invite code di dashboard (client-side render)."""
import sys, uuid, time, json, re, base64
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

# decode cookie — base64url
auth_cookie = s.cookies.get("sb-auth-auth-token.0", "")
try:
    padded = auth_cookie + "=" * (-len(auth_cookie) % 4)
    decoded = base64.urlsafe_b64decode(padded).decode()
    data = json.loads(decoded)
    print("=== decoded cookie ===")
    print("keys:", list(data.keys()))
    access_token = data.get("access_token", "")
    print("access_token len:", len(access_token))
    user = data.get("user", {})
    print("user id:", user.get("id"))
    print("email:", user.get("email"))
    print("email_verified:", user.get("email_verified"))
    print("invite_code:", user.get("invite_code"))
    print("signup_ip:", user.get("signup_ip"))
except Exception as e:
    print("decode err:", e)
    access_token = ""

# cek dashboard dengan Accept text/x-component (React Flight — data ter-render)
r2 = s.get("https://tokenharbor.ai/dashboard", timeout=30,
           headers={"Accept": "text/x-component"})
print("\ndashboard flight:", r2.status_code, len(r2.text))
# cari TH-XXXX di flight
inv = re.findall(r"TH-[A-Z0-9]{4}-[A-Z0-9]{4}", r2.text)
print("invite di flight:", set(inv) if inv else "none")
# cari referral/invite di flight
for pat in [r"invite[^\"]{0,60}", r"referral[^\"]{0,60}", r"TH-[A-Z0-9]{4}"]:
    found = re.findall(pat, r2.text, re.I)
    if found:
        print(f"pattern {pat}: {found[:5]}")

# cek API supabase langsung (kalau access token ada)
if access_token:
    # coba endpoint supabase auth
    for ep in [
        "https://tokenharbor.ai/api/auth/user",
        "https://tokenharbor.ai/api/user",
        "https://tokenharbor.ai/api/me",
    ]:
        try:
            r3 = s.get(ep, timeout=15, headers={"Authorization": f"Bearer {access_token}"})
            print(f"API {ep}: {r3.status_code} {r3.text[:200]}")
        except Exception as e:
            print(f"API {ep}: ERR {type(e).__name__}")
