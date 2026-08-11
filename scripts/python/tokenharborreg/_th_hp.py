"""Test signup TokenHarbor via tunnel HP (socks5://127.0.0.1:1080)."""
import sys, uuid, time, json
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from tokenharborreg.__main__ import _make_session, _parse_action, SIGNUP_URL, API_BASE, _passwd

proxy = "socks5://127.0.0.1:1080"
s = _make_session(proxy)
fp = str(uuid.uuid4())

# 1. GET signup page
r0 = s.get(SIGNUP_URL, timeout=30)
print("page:", r0.status_code, len(r0.text))
action_id = _parse_action(r0.text)
if isinstance(action_id, tuple):
    action_id = action_id[0]
print("action:", action_id)

# 2. precheck
r1 = s.get(API_BASE + "/api/auth/signup-precheck?fp=" + fp, timeout=15)
print("precheck:", r1.status_code, r1.text[:200])

# 3. submit
email = f"thhp{int(time.time())}@sintec.my.id"
password = _passwd()
print("email:", email, "passwd:", password)
files = {
    "1_device_fingerprint": (None, fp),
    "1_timezone": (None, "Asia/Jakarta"),
    "1_next": (None, "0"),
    "1_email": (None, email),
    "1_password": (None, password),
    "1_invite_code": (None, ""),
    "0": (None, '["$undefined","$K1"]'),
}
r = s.post(
    SIGNUP_URL,
    files=files,
    allow_redirects=False,
    timeout=30,
    headers={
        "Next-Action": action_id,
        "Referer": SIGNUP_URL,
        "Accept": "text/x-component",
    },
)
print("submit:", r.status_code)
body = r.text[:500]
print("body:", body)
if "error" in body:
    import re
    m = re.search(r'"error":"([^"]+)"', body)
    if m:
        print("ERROR MSG:", m.group(1))
