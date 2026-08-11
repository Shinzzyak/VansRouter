"""Ambil invite code dari /dashboard/invites."""
import sys, re, json
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
import requests, urllib3
urllib3.disable_warnings()

s = requests.Session()
s.proxies = {"http": "socks5://127.0.0.1:1080", "https": "socks5://127.0.0.1:1080"}
s.verify = False
s.headers.update({"User-Agent": "Mozilla/5.0", "Accept": "text/x-component"})

# login
r0 = s.get("https://tokenharbor.ai/login", timeout=30)
m = re.search(r'name="\$ACTION_1:0" value="([^"]+)"', r0.text)
key = re.search(r'name="\$ACTION_KEY" value="([^"]+)"', r0.text)
payload = json.loads(m.group(1).replace("&quot;", '"'))
aid, akey = payload.get("id"), key.group(1)
files = {
    "1_email": (None, "macanlembayung21@sintec.my.id"),
    "1_password": (None, "U6jC4MQxkcJ8Th"),
    "1_next": (None, "0"),
    "0": (None, '["$undefined","$K1"]'),
    "$ACTION_REF_1": (None, ""),
    "$ACTION_1:0": (None, '{"id":"%s","bound":"$@1"}' % aid),
    "$ACTION_1:1": (None, '["$undefined"]'),
    "$ACTION_KEY": (None, akey),
}
r = s.post("https://tokenharbor.ai/login", files=files, allow_redirects=False, timeout=30,
           headers={"Next-Action": aid, "Referer": "https://tokenharbor.ai/login"})
print("login:", r.status_code)

# GET /dashboard/invites
r2 = s.get("https://tokenharbor.ai/dashboard/invites", timeout=30, headers={"Accept": "text/x-component"})
print("invites page:", r2.status_code, len(r2.text))
html = r2.text
# cari TH-XXXX-XXXX
inv = re.findall(r"TH-[A-Z0-9]{4}-[A-Z0-9]{4}", html)
print("invite codes:", set(inv) if inv else "none")
# cari pola invite lain
for pat in [r"[A-Z0-9]{4}-[A-Z0-9]{4}", r"invite[^\"]{0,80}", r"code[^\"]{0,60}"]:
    found = re.findall(pat, html)
    if found:
        print(f"pattern {pat}: {found[:8]}")
# dump context sekitar "invite"
for kw in ["invite", "Invite", "code", "Code", "referral", "Referral"]:
    idx = html.find(kw)
    if idx > 0:
        print(f"\n=== context {kw} ===")
        print(html[max(0, idx-200):idx+300][:500])
        break
