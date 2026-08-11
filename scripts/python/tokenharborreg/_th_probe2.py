import sys
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from tokenharborreg.__main__ import _make_session, _parse_action, SIGNUP_URL, API_BASE
import uuid, re

s = _make_session(None)
fp = str(uuid.uuid4())
r = s.get(SIGNUP_URL, timeout=30)
print("page:", r.status_code)
action_id, action_key = _parse_action(r.text)
print("action:", action_id)

# test 1: password dengan digit (pasti valid)
state = '["$undefined","$K1"]'
files = {
    "1_device_fingerprint": (None, fp),
    "1_timezone": (None, "Asia/Jakarta"),
    "1_next": (None, ""),
    "1_email": (None, "testprobe42@sintec.my.id"),
    "1_password": (None, "Abcdef12345!@#"),
    "1_invite_code": (None, ""),
    "0": (None, state),
}
r2 = s.post(SIGNUP_URL, files=files, allow_redirects=False, timeout=30,
            headers={"Next-Action": action_id, "Referer": SIGNUP_URL, "Accept": "text/x-component"})
print("submit1:", r2.status_code)
print("body1:", r2.text[:600])
