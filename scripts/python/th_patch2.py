import re

p = "tokenharborreg/__main__.py"
src = open(p).read()

old = 'def _make_session(proxy=None):\n    s = requests.Session()\n    s.headers.update({"User-Agent": _ua()})'
new = (
    'def _make_session(proxy=None):\n'
    '    s = requests.Session()\n'
    '    s.headers.update({\n'
    '        "User-Agent": _ua(),\n'
    '        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",\n'
    '        "Accept-Language": "en-US,en;q=0.9",\n'
    '        "sec-ch-ua": \'"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"\',\n'
    '        "sec-ch-ua-mobile": "?0",\n'
    '        "sec-ch-ua-platform": \'"Windows"\',\n'
    '        "sec-fetch-dest": "document",\n'
    '        "sec-fetch-mode": "navigate",\n'
    '        "sec-fetch-site": "none",\n'
    '    })'
)
assert old in src, "pattern not found"
src = src.replace(old, new, 1)
open(p, "w").write(src)
print("patched OK")
