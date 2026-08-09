"""Driftz temp-mail fallback for qoderreg (YYDS API is web-app-only now).

Port of driftz_mail.py from qoder-docker/grok-register (Aug 7 2026).
Creates a fresh inbox on a random public driftz domain; polls for Qoder OTP.
Pure stdlib (urllib) — no extra deps.
"""
import json
import random
import re
import string
import time
import urllib.request

BASE = "https://api.driftz.net"


def driftz_create_inbox():
    """Create a fresh driftz inbox → (address, None)."""
    req = urllib.request.Request(f"{BASE}/domains", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        j = json.loads(r.read())
    domains = (j.get("result") or {}).get("public") or ["vwh.sh"]
    # rotate through less-common public domains; avoid vwh.sh if blacklisted
    domain = random.choice([d for d in domains if d not in ("vwh.sh", "driftz.net")] or domains)
    local = "q" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8)) + format(int(time.time()) % 10000, "04x")
    return f"{local}@{domain}", None


def driftz_poll_otp(email, timeout_s=240, interval=8, inbox_id=None):
    """Poll driftz for 6-digit OTP from Qoder."""
    deadline = time.time() + timeout_s
    seen = set()
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"{BASE}/emails/{email}", headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read())
            items = (j.get("result") or {}).get("items") or []
            for item in items:
                mid = item.get("id")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                try:
                    with urllib.request.urlopen(
                        urllib.request.Request(f"{BASE}/inbox/{mid}", headers={"User-Agent": "Mozilla/5.0"}),
                        timeout=20,
                    ) as r2:
                        md = json.loads(r2.read())
                    if md.get("success"):
                        res = md.get("result") or {}
                        all_txt = str(res.get("htmlContent") or "") + str(res.get("textContent") or "")
                        if "qoder" in all_txt.lower() or "verification" in all_txt.lower() or "verify" in all_txt.lower():
                            m6 = re.search(r"\b(\d{6})\b", all_txt)
                            if m6:
                                return m6.group(1)
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(interval)
    return None
