"""Verifikasi akun thhp1786450865@sintec.my.id — submit ulang email sama."""
import sys, uuid, time, json, re
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from tokenharborreg.__main__ import _make_session, _parse_action, SIGNUP_URL, API_BASE

proxy = "socks5://127.0.0.1:1080"
s = _make_session(proxy)
fp = str(uuid.uuid4())

r0 = s.get(SIGNUP_URL, timeout=30)
action_id = _parse_action(r0.text)
if isinstance(action_id, tuple):
    action_id = action_id[0]
print("action:", action_id)

email = "thhp1786450865@sintec.my.id"  # email yang sama dari run sukses
password = "@2qwJcMJsB5Nw8"  # password yang sama
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
body = r.text[:800]
print("body:", body)
m = re.search(r'"error":"([^"]+)"', body)
if m:
    print("ERROR MSG:", m.group(1))
