"""Login + ambil invite code dari dashboard TokenHarbor."""
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
m = re.search(r'name="\$ACTION_1:0" value="([^"]+)"', r0.text)
key = re.search(r'name="\$ACTION_KEY" value="([^"]+)"', r0.text)
if not m or not key:
    print("action tidak ditemukan")
    sys.exit(1)
payload = json.loads(m.group(1).replace("&quot;", '"'))
action_id = payload.get("id")
action_key = key.group(1)

# 2. POST login
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
print("login:", r.status_code)
print("cookies:", dict(s.cookies))

# 3. GET dashboard
r2 = s.get("https://tokenharbor.ai/dashboard", timeout=30)
print("dashboard:", r2.status_code, len(r2.text))
# cari invite code TH-XXXX
inv = re.findall(r"TH-[A-Z0-9]{4}-[A-Z0-9]{4}", r2.text)
print("invite codes:", set(inv) if inv else "TIDAK ADA")
# cari referal/referral text
ref = re.findall(r'[Rr]eferral[^<]{0,100}', r2.text)
for x in ref[:5]:
    print("ref:", x[:120])
# cari balance/credit
bal = re.findall(r'[Bb]alance[^<]{0,80}', r2.text)
for x in bal[:5]:
    print("bal:", x[:100])
