#!/usr/bin/env python3
"""
ZAI quota poller — X-Signature (Tre) rebuild VERIFIED 17-Agu-2026.
Poll feature-quota untuk semua akun zcode di VansRouter DB.
Output: akun yang quota-nya sudah reset (bisa dipakai lagi).

Cara pakai:
  python3 zai_quota_poll.py [--db /path/to/data.sqlite] [--sleep 1.0]
"""
import json, os, sys, time, uuid, hashlib, hmac, base64, sqlite3
import urllib.request, urllib.parse, urllib.error, argparse

SECRET = "key-@@@@)))()((9))-xxxx&&&%%%%%"
BASE = "https://chat.z.ai"
DEFAULT_DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def tre_signature(user_id, message, ts=None):
    """Rebuild Tre() dari bundle z.ai (hash identik bundle — verified)."""
    ts = ts or int(time.time() * 1000)
    m = ts // 300000
    request_id = str(uuid.uuid4())
    entries = [("requestId", request_id), ("timestamp", str(ts)), ("user_id", str(user_id))]
    entries.sort(key=lambda x: x[0])
    sorted_payload = ",".join(v for _, v in entries)
    msg_b64 = b64u(message.encode())
    h = f"{sorted_payload}|{msg_b64}|{ts}"
    sig1 = hmac.new(SECRET.encode(), str(m).encode(), hashlib.sha256).hexdigest()
    sig = hmac.new(sig1.encode(), h.encode(), hashlib.sha256).hexdigest()
    return sig, ts, request_id

def make_url_params(user_id, token, ts, request_id):
    params = {
        "timestamp": str(ts),
        "requestId": request_id,
        "user_id": str(user_id),
        "version": "0.0.1",
        "platform": "web",
        "token": token,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "language": "en-US",
        "timezone": "Asia/Singapore",
        "screen_width": "1280",
        "screen_height": "800",
        "viewport_width": "1280",
        "viewport_height": "800",
        "referrer": "https://chat.z.ai/",
        "title": "Z.AI",
    }
    return urllib.parse.urlencode(params)

def signed_get(user_id, token, path):
    ts = int(time.time() * 1000)
    sig, ts2, rid = tre_signature(user_id, path, ts)
    params = make_url_params(user_id, token, ts, rid)
    url = f"{BASE}{path}?{params}&signature_timestamp={ts}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "X-Signature": sig,
        "X-FE-Version": "prod-fe-1.1.87",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })
    try:
        r = urllib.request.urlopen(req, timeout=20)
        return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read()[:200].decode(errors="replace")}

def load_accounts(db_path):
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT id, name, data FROM providerConnections WHERE provider='zcode' OR provider='zai'"
    ).fetchall()
    conn.close()
    out = []
    for cid, name, data in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        psd = d.get("providerSpecificData") or {}
        token = d.get("accessToken") or psd.get("zcodeJwtToken")
        if not token:
            continue
        uid = d.get("userId") or d.get("user_id") or psd.get("userId")
        if not uid:
            try:
                bt = psd.get("businessToken", "")
                p2 = bt.split(".")[1]
                p2 += "=" * (-len(p2) % 4)
                uid = json.loads(base64.urlsafe_b64decode(p2)).get("user_id")
            except Exception:
                uid = ""
        out.append({"id": cid, "name": name, "token": token, "uid": str(uid)})
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--sleep", type=float, default=2.0, help="delay antar akun (rate limit 405 kalau terlalu cepat)")
    ap.add_argument("--limit", type=int, default=0, help="max akun (0=all)")
    args = ap.parse_args()

    accounts = load_accounts(args.db)
    if args.limit:
        accounts = accounts[:args.limit]
    print(f"Total ZAI accounts: {len(accounts)}")

    results = []
    ok = err = 0
    for i, a in enumerate(accounts):
        r = signed_get(a["uid"], a["token"], "/api/v1/dashboard/feature-quota/summary")
        code = r.get("code", r.get("_http_error", "ERR"))
        if code == 0:
            ok += 1
        else:
            err += 1
        reset_at = (r.get("data") or {}).get("reset_at", "")
        results.append({"name": a["name"], "id": a["id"][:8], "code": code, "reset_at": reset_at})
        print(f"[{i+1}/{len(accounts)}] {a['name']}: code={code} reset_at={reset_at}")
        time.sleep(args.sleep)

    with open("/tmp/zai_quota_poll.json", "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nOK: {ok} | ERR: {err} | saved → /tmp/zai_quota_poll.json")

if __name__ == "__main__":
    main()