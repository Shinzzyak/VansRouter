import re

p = "tokenharborreg/__main__.py"
src = open(p).read()

# 1. tambah fungsi retry helper sebelum register_one
old = "def register_one(yyds_key, yyds_domain, seed_invite, proxy, index, email_override=None, password_override=None):\n    s = _make_session(proxy)"
new = """def _retry_get(s, url, tries=5, delay=5):
    \"\"\"Gateway 8081 flaky (pool proxy di belakang) — retry sampai 200.\"\"\"
    last = None
    for i in range(tries):
        try:
            r = s.get(url, timeout=30)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)[:100]
        time.sleep(delay * (i + 1))
    raise RuntimeError(f"GET retry habis: {last}")


def register_one(yyds_key, yyds_domain, seed_invite, proxy, index, email_override=None, password_override=None):
    s = _make_session(proxy)"""
assert old in src, "pattern register_one not found"
src = src.replace(old, new, 1)

# 2. ganti GET signup page dengan retry
old2 = """    # 1. fetch signup page for action ids
    r = s.get(SIGNUP_URL, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"signup page HTTP {r.status_code}")"""
new2 = """    # 1. fetch signup page for action ids (retry — gateway flaky)
    r = _retry_get(s, SIGNUP_URL)"""
assert old2 in src, "pattern signup page not found"
src = src.replace(old2, new2, 1)

open(p, "w").write(src)
print("patched OK")
