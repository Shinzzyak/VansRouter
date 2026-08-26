"""Tempik (own-domain) temp-mail — Qoder register OTP receive.

Port of tempik_mail.py from qoder-docker/grok-register (Aug 7 2026).
Uses tempik.exilion.my.id API (own Cloudflare domain, not blacklisted).
Pure stdlib (urllib) — no extra deps.
"""
import json
import random
import re
import time
import urllib.request

BASE = "https://tempik.exilion.my.id/api"

# Semua mail domain yang terdaftar di worker tempik (16). Rotasi per request
# supaya tiap inbox pack domain beda (yyds-style auto-unique per domain/req).
MAIL_DOMAINS = [
    "atherberg.biz.id", "byungu.bond", "cheonsam.web.id", "chusyuan.biz.id",
    "clusal.web.id", "exilion.my.id", "khisnami.my.id", "mayshia.cyou",
    "noctis.biz.id", "nyktor.my.id", "schatten.biz.id", "sintec.my.id",
    "valerius.biz.id", "wolfeus.my.id", "wolfus.my.id", "zchyur.my.id",
]


def _req(method, path, headers=None, body=None, timeout=20):
    data = json.dumps(body).encode() if body else None
    hdrs = headers or {}
    hdrs.setdefault("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def tempik_create_inbox(domain=None):
    """Create a fresh inbox → (address, session_id).

    domain: force a specific MAIL_DOMAINS entry (default: random rotation,
    yyds-style auto-unique per request — setiap call domain beda).
    """
    sid = _req("GET", "/session").get("sessionId")
    if not domain:
        domain = random.choice(MAIL_DOMAINS)
    body = {"domain": domain} if domain else {}
    addr = _req("POST", "/inboxes", {"x-session-id": sid, "Content-Type": "application/json"}, body).get("address")
    if not addr:
        raise RuntimeError("tempik create inbox failed")
    return addr, sid


def tempik_poll_otp(email, timeout_s=240, interval=8, session_id=None):
    """Poll tempik for 6-digit OTP from Qoder."""
    if not session_id:
        return None
    deadline = time.time() + timeout_s
    seen = set()
    while time.time() < deadline:
        try:
            inboxes = _req("GET", "/inboxes", {"x-session-id": session_id})
            for box in inboxes:
                if box.get("address") != email:
                    continue
                mails = _req("GET", f"/inboxes/{box.get('address')}/messages",
                             {"x-session-id": session_id})
                for m in mails:
                    mid = m.get("id")
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    txt = str(m.get("htmlContent") or m.get("textContent") or m.get("body") or m.get("snippet") or "")
                    # tempik message shape may vary — include all string fields
                    if not txt:
                        txt = json.dumps(m)[:2000]
                    if "qoder" in txt.lower() or "verification" in txt.lower() or "verify" in txt.lower():
                        m6 = re.search(r"\b(\d{6})\b", txt)
                        if m6:
                            return m6.group(1)
        except Exception:
            pass
        time.sleep(interval)
    return None
