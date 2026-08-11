"""Screening massal proxy score=0 — cari IP fresh yang precheck needCaptcha:false
dan submit tidak kena "Too many sign-ups"."""
import sys, uuid, time, json
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
import sqlite3
import requests

db = sqlite3.connect("/home/ubuntu/proxy-scraper/data/proxies.db")
# ambil proxy score=0 yang masih hidup — http protocol, tanpa filter last_seen
# (score=0 sample punya last_seen='' — auto-ban set score 0 tapi last_seen kosong)
rows = db.execute("""
    SELECT ip, port, country_code FROM proxies
    WHERE score = 0 AND protocol = 'http'
    ORDER BY response_time_ms ASC LIMIT 60
""").fetchall()
print(f"candidates: {len(rows)}")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

def test_proxy(ip, port):
    proxy = f"http://{ip}:{port}"
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.proxies.update({"http": proxy, "https": proxy})
    s.verify = False
    import urllib3
    urllib3.disable_warnings()
    fp = str(uuid.uuid4())
    try:
        # 1. egress check
        r0 = s.get("http://api.ipify.org", timeout=8)
        egress = r0.text.strip()
        if not egress or egress == ip:
            return None, "egress-fail"
        # 2. precheck
        r = s.get("https://tokenharbor.ai/api/auth/signup-precheck?fp=" + fp, timeout=10)
        if r.status_code != 200:
            return None, f"precheck-{r.status_code}"
        need = (r.json() or {}).get("needCaptcha")
        return egress, "captcha" if need else "clean"
    except Exception as e:
        return None, type(e).__name__

results = {"clean": [], "captcha": [], "fail": []}
for ip, port, cc in rows:
    egress, status = test_proxy(ip, port)
    if egress:
        results[status if status in results else "fail"].append((ip, port, cc, egress, status))
    else:
        results["fail"].append((ip, port, cc, None, status))
    if len(results["clean"]) >= 5:
        break
    time.sleep(0.3)

print(f"\n=== CLEAN (needCaptcha:false) ===")
for r in results["clean"]:
    print(f"  {r[0]}:{r[1]} ({r[2]}) egress={r[3]}")
print(f"\n=== CAPTCHA ===")
for r in results["captcha"][:10]:
    print(f"  {r[0]}:{r[1]} ({r[2]}) egress={r[3]}")
print(f"\n=== FAIL ({len(results['fail'])}) ===")
from collections import Counter
print(Counter(r[4] for r in results["fail"]))
