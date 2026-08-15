import re

p = "tokenharborreg/__main__.py"
src = open(p).read()

old = '''def _retry_get(s, url, tries=5, delay=5):
    """Gateway 8081 flaky (pool proxy di belakang) — retry sampai 200."""
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
    raise RuntimeError(f"GET retry habis: {last}")'''

new = '''def _retry_get(s, url, tries=5, delay=5):
    """Gateway 8081 flaky — retry pakai session BARU tiap attempt (egress beda,
    IP burn di satu proxy tidak memblokir attempt berikutnya)."""
    last = None
    for i in range(tries):
        try:
            r = s.get(url, timeout=30)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)[:100]
        if i < tries - 1:
            proxy = s.proxies.get("https") or s.proxies.get("http") or ""
            if proxy:
                s = _make_session(proxy)  # session baru = egress baru (rotasi)
        time.sleep(delay * (i + 1))
    raise RuntimeError(f"GET retry habis: {last}")'''

assert old in src, "pattern not found"
src = src.replace(old, new, 1)
open(p, "w").write(src)
print("patched OK")
