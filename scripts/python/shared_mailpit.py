"""shared_mailpit.py — Mailpit inbox helper (domain atherberg.biz.id, MX live, lolos blocklist).

Dipasang di semua automation baru (kiro/codebuddy/cloudflare/kimchi) karena
domain tempmail publik (YYDS valerius.biz.id, driftz) DIBLOKIR oleh target
(verified 2026-08-14: baseten, tokenharbor tidak kirim verifikasi ke domain
tempmail, tapi semua email masuk Mailpit domain sendiri).
"""
import json
import random
import re
import string
import time
import urllib.request

MAILPIT_API = "http://127.0.0.1:8025"
MAILPIT_DOMAIN = "atherberg.biz.id"


def create_inbox(prefix="x"):
    """Buat alamat Mailpit baru → (email, None)."""
    local = prefix + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    email = f"{local}@{MAILPIT_DOMAIN}"
    return email, None


def wait_code(email, timeout=180, pattern=r"\b(\d{6})\b", subject_kw=None):
    """Poll Mailpit untuk OTP/code. Return (code_or_None, full_message_dict)."""
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        try:
            url = f"{MAILPIT_API}/api/v1/search?query=to:{email}&limit=10"
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            for msg in data.get("messages", []):
                mid = msg.get("ID")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                tos = [t.get("Address", "") for t in (msg.get("To") or [])]
                if email not in tos:
                    continue
                try:
                    with urllib.request.urlopen(f"{MAILPIT_API}/api/v1/message/{mid}", timeout=10) as mr:
                        full = json.loads(mr.read().decode("utf-8", "replace"))
                except Exception:
                    full = {}
                body = (full.get("Subject") or "") + "\n" + (full.get("Text") or "") + "\n" + (full.get("HTML") or "")
                if subject_kw and subject_kw.lower() not in (full.get("Subject") or "").lower():
                    continue
                m = re.search(pattern, body, re.MULTILINE)
                if m:
                    return m.group(1) if m.lastindex else m.group(0), full
        except Exception:
            pass
        time.sleep(8)
    return None, None


def wait_link(email, timeout=180, kw=("verify", "confirm")):
    """Poll Mailpit untuk link verifikasi. Return (url_or_None, full_message_dict)."""
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        try:
            url = f"{MAILPIT_API}/api/v1/search?query=to:{email}&limit=10"
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            for msg in data.get("messages", []):
                mid = msg.get("ID")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                tos = [t.get("Address", "") for t in (msg.get("To") or [])]
                if email not in tos:
                    continue
                try:
                    with urllib.request.urlopen(f"{MAILPIT_API}/api/v1/message/{mid}", timeout=10) as mr:
                        full = json.loads(mr.read().decode("utf-8", "replace"))
                except Exception:
                    full = {}
                blob = json.dumps(full)
                urls = re.findall(r"https?://[^\s\"'<>\\]+", blob)
                for u in urls:
                    if any(k in u.lower() for k in kw):
                        return u, full
        except Exception:
            pass
        time.sleep(8)
    return None, None
