#!/usr/bin/env python3
"""BULK ZCode OAuth via WARP proxy (socks5://127.0.0.1:40000).
Semua HTTP call (init/poll/claim) lewat WARP. Browser Camoufox pakai WARP juga.
"""
import sys, os, json, time, secrets, sqlite3, urllib.request, urllib.error, subprocess

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
WARP_PROXY = "socks5://127.0.0.1:40000"

import socks
import socket
from urllib.parse import urlparse


def warp_opener():
    """Urllib opener yang route semua traffic lewat WARP socks proxy."""
    proxy = urlparse(WARP_PROXY)
    socks.set_default_proxy(socks.SOCKS5, proxy.hostname, proxy.port)
    socket.socket = socks.socksocket
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener


# NOTE: WARP routing untuk urllib = set default proxy GLOBAL.
# Call urllib dengan ini, tapi Camoufox (subprocess) tidak ter-route.
# Solusi: urllib lewat WARP; browser tetap direct (atau pakai browser proxy option).


def get_accounts():
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT email, data FROM providerConnections WHERE provider='zcode' AND isActive=1").fetchall()
    conn.close()
    out = []
    for email, data in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        psd = d.get("providerSpecificData") or {}
        if psd.get("zcodeJwtToken"):
            continue
        out.append({"email": email, "cookies": psd.get("cookies", [])})
    return out


def init_flow(opener):
    poll_token = secrets.token_hex(32)
    hdrs = {"Content-Type": "application/json", "Authorization": f"Bearer {poll_token}"}
    r = opener.Request("https://zcode.z.ai/api/v1/oauth/cli/init", data=json.dumps({"provider": "zai"}).encode(), headers=hdrs, method="POST")
    with opener.urlopen(r, timeout=25) as resp:
        j = json.loads(resp.read().decode())
    d = j["data"]
    return poll_token, d["flow_id"], d["authorize_url"]


def poll_flow(opener, poll_token, flow_id, tries=30, interval=2):
    url = f"https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}"
    for i in range(tries):
        try:
            r = opener.Request(url, headers={"Authorization": f"Bearer {poll_token}"})
            with opener.urlopen(r, timeout=15) as resp:
                j = json.loads(resp.read().decode())
            st = j.get("data", {}).get("status", "?")
            if st != "pending":
                return j
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        time.sleep(interval)
    return None


def main():
    # WARP urllib global
    opener = warp_opener()
    accounts = get_accounts()
    print(f"accounts to process (via WARP): {len(accounts)}")
    results = {"ok": [], "fail": []}
    for i, acc in enumerate(accounts):
        email = acc["email"]
        print(f"[{i+1}/{len(accounts)}] {email} ...", flush=True)
        try:
            poll_token, flow_id, auth_url = init_flow(opener)
            # browser Camoufox — perlu proxy setting (biasanya lewat --proxy-server)
            # Untuk flow OAuth kita bisa pakai browser yg sudah jalan; tp optional.
            res = poll_flow(opener, poll_token, flow_id, tries=60, interval=2)
            if res:
                d = res.get("data", {})
                if d.get("status") == "ready":
                    tok = d.get("token", "")
                    at = (d.get("zai") or {}).get("access_token", "")
                    print(f"  ✓ JWT {len(tok)}c", flush=True)
                    results["ok"].append(email)
                else:
                    print(f"  ✗ status {d.get('status')}", flush=True)
                    results["fail"].append({"email": email, "err": f"status {d.get('status')}"})
            else:
                print("  ✗ poll timeout", flush=True)
                results["fail"].append({"email": email, "err": "poll timeout"})
        except Exception as e:
            print(f"  ✗ ERR {str(e)[:120]}", flush=True)
            results["fail"].append({"email": email, "err": str(e)[:120]})
        time.sleep(2)
    print("\n=== SUMMARY ===")
    print("OK:", len(results["ok"]), "| FAIL:", len(results["fail"]))
    with open("/tmp/zcode_warp_oauth_result.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()