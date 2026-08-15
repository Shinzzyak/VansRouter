import re

p = "tokenharborreg/__main__.py"
src = open(p).read()

old = '''def _make_session(proxy=None):
    s = requests.Session()
    s.headers.update({
        "User-Agent": _ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
    })'''

new = '''def _make_session(proxy=None):
    # Header PERSIS seperti _th_signup.sess (terbukti 303) — CF block kalau beda.
    s = requests.Session()
    s.headers["User-Agent"] = _ua()
    s.headers.update({"Accept": "text/x-component", "Origin": "https://tokenharbor.ai",
                      "Referer": "https://tokenharbor.ai/login?mode=signup",
                      "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
                      "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
                      "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin"})'''

assert old in src, "pattern not found"
src = src.replace(old, new, 1)
open(p, "w").write(src)
print("patched OK")
