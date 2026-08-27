#!/usr/bin/env python3
"""ZAI quota fetcher (simple) — feature-quota summary for the 108-account pool.

Reuses signed_get() from zai_quota_poll.py (X-Signature verified). Serves a
cached snapshot instantly; refreshes in a background thread when stale, so the
dashboard never blocks on the ~90s cold probe of 108 accounts.

Usage:
  python3 zai_quota_fetcher.py --once   # probe now, print, exit
  (library: get_snapshot() — instant, may return {"status":"warming"} on boot)
"""
import json, os, sys, time, sqlite3, threading
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zai_quota_poll import signed_get, load_proxies

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
QUOTA_TTL_S = 300  # 5 min
PROBE_SLEEP_S = 0.3
PROXY_PATH = "/home/ubuntu/VansRouter/scripts/python/websharereg/proxies_webshare.txt"

_cache: dict = {"ts": 0.0, "data": None}
_lock = threading.Lock()
_refreshing = False
_proxies: Optional[list] = None


def _get_proxies() -> list:
    global _proxies
    if _proxies is None:
        _proxies = load_proxies(PROXY_PATH)
    return _proxies


def _load_accounts() -> list:
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "SELECT id, name, data FROM providerConnections WHERE provider='zcode' AND isActive=1"
    ).fetchall()
    conn.close()
    return [(cid, name, json.loads(data) if data else {}) for cid, name, data in rows]


def _token_uid(d: dict):
    """Extract (token, user_id) — user_id lives in the JWT accessToken payload `id`."""
    import base64
    psd = d.get("providerSpecificData") or {}
    token = d.get("accessToken") or psd.get("zcodeJwtToken")
    if not token:
        return None, None
    uid = d.get("userId") or d.get("user_id") or psd.get("userId")
    if not uid:
        try:
            p2 = token.split(".")[1]
            p2 += "=" * (-len(p2) % 4)
            payload = json.loads(base64.urlsafe_b64decode(p2))
            uid = payload.get("id") or payload.get("user_id")
        except Exception:
            uid = ""
    return token, str(uid or "")


def _probe_one(cid: str, name: str, data: dict, idx: int) -> dict:
    row = {"name": name, "id": str(cid)[:8], "ok": False, "reset_at": ""}
    token, uid = _token_uid(data)
    if not token or not uid:
        row["error"] = "no_token_or_uid"
        return row
    proxies = _get_proxies()
    proxy = proxies[idx % len(proxies)] if proxies else None
    r = signed_get(uid, token, "/api/v1/dashboard/feature-quota/summary", proxy)
    code = r.get("code") if isinstance(r, dict) else None
    if code != 0 and proxy:
        # proxy died (407/timeout) -> retry direct
        r = signed_get(uid, token, "/api/v1/dashboard/feature-quota/summary", None)
    if not isinstance(r, dict):
        row["error"] = "bad_response"
        return row
    code = r.get("code")
    if code == 0:
        data_ = r.get("data") or {}
        reset = data_.get("reset_at") if isinstance(data_, dict) else ""
        row.update(ok=True, reset_at=str(reset or ""))
    else:
        row["error"] = str(code)[:80]
    return row


def _probe_all() -> dict:
    accounts = _load_accounts()
    results, ok = [], 0
    for i, (cid, name, data) in enumerate(accounts):
        r = _probe_one(cid, name, data, i)
        ok += 1 if r.get("ok") else 0
        results.append(r)
        time.sleep(PROBE_SLEEP_S)
    return {"fetched_at": int(time.time()), "total": len(accounts),
            "ok": ok, "err": len(accounts) - ok, "accounts": results}


def _refresh_async() -> None:
    global _refreshing
    with _lock:
        if _refreshing:
            return
        _refreshing = True

    def run():
        global _refreshing
        try:
            snap = _probe_all()
            with _lock:
                _cache["ts"] = time.time()
                _cache["data"] = snap
        finally:
            _refreshing = False

    threading.Thread(target=run, daemon=True).start()


def get_snapshot() -> dict:
    """Instant: cached snapshot if any (refresh kicked off if stale), else warming."""
    with _lock:
        snap = _cache["data"]
        fresh = snap and (time.time() - _cache["ts"]) < QUOTA_TTL_S
    if snap and not fresh:
        _refresh_async()
    if snap:
        return snap
    _refresh_async()
    return {"status": "warming", "total": 108, "ttl_s": QUOTA_TTL_S}


if __name__ == "__main__":
    snap = _probe_all()
    print(json.dumps(snap, indent=1)[:3000])
    print(f"\n({snap['total']} akun, ok={snap['ok']}, err={snap['err']})")