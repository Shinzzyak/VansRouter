import sys, uuid, re
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from tokenharborreg.__main__ import _make_session, _parse_action, SIGNUP_URL, API_BASE

# test via WARP proxy :40000 (egress 104.28.222.43)
proxy = "http://127.0.0.1:40000"
s = _make_session(proxy)
fp = str(uuid.uuid4())

# cek egress via WARP
try:
    r0 = s.get("http://api.ipify.org", timeout=15)
    print("warp egress:", r0.text[:100])
except Exception as e:
    print("warp egress err:", e)

r = s.get(SIGNUP_URL, timeout=30)
print("page:", r.status_code, len(r.text))
action_id, action_key = _parse_action(r.text)
print("action:", action_id)
pre = s.get(f"{API_BASE}/api/auth/signup-precheck?fp={fp}", timeout=15)
print("precheck:", pre.status_code, pre.json() if pre.status_code == 200 else pre.text[:100])

state = '["$undefined","$K1"]'
files = {
    "1_device_fingerprint": (None, fp),
    "1_timezone": (None, "Asia/Jakarta"),
    "1_next": (None, ""),
    "1_email": (None, "warpth88@sintec.my.id"),
    "1_password": (None, "Abcdef12345!@#"),
    "1_invite_code": (None, ""),
    "0": (None, state),
}
r2 = s.post(SIGNUP_URL, files=files, allow_redirects=False, timeout=30,
            headers={"Next-Action": action_id, "Referer": SIGNUP_URL, "Accept": "text/x-component"})
print("submit:", r2.status_code)
print("body:", r2.text[:600])
