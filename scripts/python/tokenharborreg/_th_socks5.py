"""Test proxy socks5 fresh langsung ke tokenharbor precheck (bypass gateway)."""
import sys, uuid, time
sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python")
import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

proxies = [
    ("13.244.203.188", 16157, "ZA"),
    ("45.144.54.40", 1080, "DE"),
    ("43.164.136.189", 1080, "KR"),
    ("220.158.233.26", 1080, "KH"),
    ("220.112.1.194", 1088, "CN"),
    ("147.45.166.120", 3333, "NL"),
]

for ip, port, cc in proxies:
    proxy = f"socks5://{ip}:{port}"
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    s.proxies.update({"http": proxy, "https": proxy})
    s.verify = False
    import urllib3
    urllib3.disable_warnings()
    fp = str(uuid.uuid4())
    try:
        r0 = s.get("http://api.ipify.org", timeout=10)
        egress = r0.text.strip()
        r = s.get("https://tokenharbor.ai/api/auth/signup-precheck?fp=" + fp, timeout=12)
        need = (r.json() or {}).get("needCaptcha") if r.status_code == 200 else f"HTTP{r.status_code}"
        print(f"{ip}:{port} ({cc}) egress={egress} precheck={need}")
    except Exception as e:
        print(f"{ip}:{port} ({cc}) ERR {type(e).__name__}: {str(e)[:80]}")
    time.sleep(0.5)
