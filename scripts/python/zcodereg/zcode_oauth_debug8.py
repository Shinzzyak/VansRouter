#!/usr/bin/env python3
"""Debug8: test beberapa redirect URI — cari yg diterima server (bukan 'not registered')."""
import sys, os, json, time, uuid, sqlite3, urllib.parse, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zcode_oauth_localhost import load_account

email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
acc = load_account(email)

# test tanpa browser — fetch authorize URL, cek body
variants = [
    "http://127.0.0.1:3000/oauth/callback/zai",
    "http://localhost:3000/oauth/callback/zai",
    "http://127.0.0.1:44224/oauth/callback/zai",
    "http://localhost:44224/oauth/callback/zai",
    "zcode://zai-auth/callback",
    "http://127.0.0.1/oauth/callback/zai",
    "http://localhost/oauth/callback/zai",
]
for uri in variants:
    state = uuid.uuid4().hex
    url = ("https://chat.z.ai/api/oauth/authorize?"
           f"redirect_uri={urllib.parse.quote(uri, safe='')}&response_type=code"
           "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=" + state)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode()[:200]
            print(f"{uri[:50]:55s} -> {r.status} {body[:100]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f"{uri[:50]:55s} -> {e.code} {body[:100]}")
    except Exception as e:
        print(f"{uri[:50]:55s} -> ERR {str(e)[:80]}")