#!/usr/bin/env python3
"""OpenCode Console device login -> per-account free-lane token.

Flow (RFC 8628, same endpoints the CLI uses):
  POST /console/auth/device/code  {"client_id":"opencode-cli","supports_org_scope":true}
  user opens https://opencode.ai/console/device?user_code=XXXX-XXXX and approves
  POST /console/auth/device/token {"grant_type":"...,device_code","device_code":...,"client_id":"opencode-cli"}
  -> access_token + refresh_token (rotated on every refresh: always persist the new pair)

Usage:
  python3 opencode-device-login.py --label avres        # interactive, saves default
  python3 opencode-device-login.py --list               # show saved accounts + expiry
  python3 opencode-device-login.py --refresh            # refresh every saved account

Store: ~/.config/opencode-accounts.json  (mode 600)
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

SERVER = "https://opencode.ai/console"
CLIENT_ID = "opencode-cli"
STORE = os.path.expanduser("~/.config/opencode-accounts.json")


def post(path, payload):
    req = urllib.request.Request(
        SERVER + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "user-agent": "opencode/latest/cli"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf8", "ignore")
        try:
            return e.code, json.loads(body or "{}")
        except json.JSONDecodeError:
            return e.code, {"error": body[:200]}


def load():
    if not os.path.exists(STORE):
        return {"accounts": []}
    with open(STORE) as f:
        return json.load(f)


def save(data):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    tmp = STORE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STORE)


def login(label):
    st, code = post("/auth/device/code", {"client_id": CLIENT_ID, "supports_org_scope": True})
    if st != 200:
        sys.exit(f"device/code failed: {st} {code}")
    url = "https://opencode.ai" + code["verification_uri_complete"]
    print(f"open this and approve as {label}:\n  {url}\n  code: {code['user_code']}")
    wait = int(code.get("interval", 5))
    deadline = time.time() + int(code.get("expires_in", 600))
    while time.time() < deadline:
        time.sleep(wait)
        st, tok = post(
            "/auth/device/token",
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": code["device_code"],
                "client_id": CLIENT_ID,
            },
        )
        if st == 200 and "access_token" in tok:
            acc = {
                "label": label,
                "access": tok["access_token"],
                "refresh": tok["refresh_token"],
                "expires": int(time.time() * 1000) + int(tok.get("expires_in", 3600)) * 1000,
                "org_id": tok.get("org_id"),
            }
            data = load()
            data["accounts"] = [a for a in data["accounts"] if a["label"] != label] + [acc]
            save(data)
            print(f"saved {label} -> {STORE} (access ...{acc['access'][-6:]})")
            return
        err = tok.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            wait += 5
            continue
        sys.exit(f"device/token failed: {st} {tok}")


def refresh_all():
    data = load()
    now = int(time.time() * 1000)
    for acc in data["accounts"]:
        if acc["expires"] - now > 120_000:
            print(f"{acc['label']}: fresh ({(acc['expires']-now)//60000}m left)")
            continue
        st, tok = post(
            "/auth/device/token",
            {"grant_type": "refresh_token", "refresh_token": acc["refresh"], "client_id": CLIENT_ID},
        )
        if st != 200 or "access_token" not in tok:
            print(f"{acc['label']}: REFRESH FAILED {st} {tok}")
            continue
        acc.update(
            access=tok["access_token"],
            refresh=tok["refresh_token"],
            expires=now + int(tok.get("expires_in", 3600)) * 1000,
            org_id=tok.get("org_id"),
        )
        print(f"{acc['label']}: refreshed")
    save(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="avres")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    if a.list:
        now = int(time.time() * 1000)
        for acc in load()["accounts"]:
            print(f"{acc['label']}: ...{acc['access'][-6:]} expires in {(acc['expires']-now)//60000}m")
        return
    if a.refresh:
        return refresh_all()
    login(a.label)


if __name__ == "__main__":
    main()
