#!/usr/bin/env python3
"""Debug9: test authorize dengan berbagai UA + cek redirect response (mungkin perlu UA zcode)."""
import sys, os, json, uuid, urllib.parse, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test(ua, uri="http://127.0.0.1:3000/oauth/callback/zai"):
    state = uuid.uuid4().hex
    url = ("https://chat.z.ai/api/oauth/authorize?"
           f"redirect_uri={urllib.parse.quote(uri, safe='')}&response_type=code"
           "&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=" + state)
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode()[:300]
            print(f"UA={ua[:40]:42s} -> {r.status} | {body[:150]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        print(f"UA={ua[:40]:42s} -> {e.code} | {body[:150]}")
    except Exception as e:
        print(f"UA={ua[:40]:42s} -> ERR {str(e)[:80]}")

# UA varian
UAs = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "ZCode/3.1.0",
    "ZCode/3.10.0",
    "ZCode/3.1.0 (Windows) Electron/30.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 zdoc",
    "zcode-desktop/3.10.0",
]
for ua in UAs:
    test(ua)

# juga test redirect berbeda dengan UA Chrome
print("\n=== redirect variants (UA Chrome) ===")
for uri in ["http://127.0.0.1:3000/oauth/callback/zai",
            "http://localhost:3000/callback",
            "http://127.0.0.1:44224/zdoc",
            "zcode://zai-auth/callback"]:
    test("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", uri)