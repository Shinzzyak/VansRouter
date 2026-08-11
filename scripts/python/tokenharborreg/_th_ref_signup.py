"""E2E: signup akun baru DENGAN invite code TH-LWVN-43VV (referral chain)."""
import sys, uuid, time, json, re
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
from tokenharborreg.__main__ import _make_session, _parse_action, SIGNUP_URL, API_BASE, _passwd
from qoderreg._tempik import tempik_create_inbox, _req

proxy = "socks5://127.0.0.1:1080"
INVITE = "TH-LWVN-43VV"  # invite code head 1 (macanlembayung21)

# 1. create tempik inbox
addr, sid = tempik_create_inbox()
print("inbox:", addr)

# 2. signup dengan invite
s = _make_session(proxy)
fp = str(uuid.uuid4())
r0 = s.get(SIGNUP_URL, timeout=30)
action_id, action_key = _parse_action(r0.text)
print("action:", action_id, "key:", action_key)

email = addr
password = _passwd()
print("email:", email, "passwd:", password)
files = {
    "1_device_fingerprint": (None, fp),
    "1_timezone": (None, "Asia/Jakarta"),
    "1_next": (None, "0"),
    "1_email": (None, email),
    "1_password": (None, password),
    "1_invite_code": (None, INVITE),
    "0": (None, '["$undefined","$K1"]'),
    "$ACTION_REF_1": (None, ""),
    "$ACTION_1:0": (None, '{"id":"%s","bound":"$@1"}' % action_id),
    "$ACTION_1:1": (None, '["$undefined"]'),
    "$ACTION_KEY": (None, action_key),
}
r = s.post(
    SIGNUP_URL,
    files=files,
    allow_redirects=False,
    timeout=30,
    headers={"Next-Action": action_id, "Referer": SIGNUP_URL, "Accept": "text/x-component"},
)
print("submit:", r.status_code)
body = r.text[:400]
print("body:", body)
m = re.search(r'"error":"([^"]+)"', body)
if m:
    print("ERROR MSG:", m.group(1))
    sys.exit(1)

# 3. poll verify email
print("polling verify email...")
deadline = time.time() + 240
seen = set()
found = False
while time.time() < deadline and not found:
    try:
        inboxes = _req("GET", "/inboxes", {"x-session-id": sid})
        for box in inboxes:
            if box.get("address") != addr:
                continue
            mails = _req("GET", f"/inboxes/{box.get('address')}/messages", {"x-session-id": sid})
            for msg in mails:
                mid = msg.get("id")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                txt = str(msg.get("htmlContent") or msg.get("textContent") or msg.get("body") or msg.get("snippet") or "")
                subj = str(msg.get("subject") or "")
                print(f"MSG from={msg.get('from')} subj={subj[:60]}")
                print(f"  txt: {txt[:300]}")
                if "tokenharbor" in txt.lower() or "verify" in txt.lower() or "confirm" in txt.lower():
                    found = True
                    vm = re.search(r'https?://[^\s"<>]+', txt)
                    if vm:
                        print("VERIFY LINK:", vm.group(0))
    except Exception as e:
        print("poll ERR:", type(e).__name__, str(e)[:100])
    time.sleep(10)

print("RESULT:", "VERIFY EMAIL FOUND ✅" if found else "verify email not found ❌")
print("CREDS:", email, password)
