"""YYDS temp mail client — create inbox + poll OTP (requests only)."""
import re
import time

import requests

YYDS_BASE = "https://maliapi.215.im/v1"


def yyds_headers(api_key):
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def yyds_create_inbox(api_key, domain):
    """Create a fresh temp inbox → (address, inbox_id)."""
    r = requests.post(
        f"{YYDS_BASE}/inboxes", headers=yyds_headers(api_key),
        json={"domain": domain}, timeout=30)
    r.raise_for_status()
    j = r.json()
    d = j.get("data") or j
    return (d.get("address") or d.get("email") or d.get("id")), d.get("id")


def yyds_poll_otp(api_key, inbox_id, timeout_s=180, interval=8):
    """Poll inbox for a 6-digit code from Qoder. Returns code or None."""
    deadline = time.time() + timeout_s
    seen = set()
    while time.time() < deadline:
        try:
            r = requests.get(
                f"{YYDS_BASE}/inboxes/{inbox_id}/messages",
                headers=yyds_headers(api_key), timeout=20)
            if r.status_code == 200:
                j = r.json()
                msgs = ((j.get("data") or {}).get("messages")
                        or j.get("messages") or [])
                for m in msgs:
                    mid = m.get("id")
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    try:
                        r2 = requests.get(
                            f"{YYDS_BASE}/messages/{mid}",
                            headers=yyds_headers(api_key), timeout=20)
                        md = (r2.json().get("data") or {}) if r2.status_code == 200 else {}
                        vc = md.get("verificationCode")
                        if vc and re.fullmatch(r"\d{6}", str(vc)):
                            return str(vc)
                        body = str(md.get("text") or "")
                        if isinstance(md.get("html"), str):
                            body += md["html"]
                        if "qoder" in body.lower() or "verification" in body.lower():
                            m6 = re.search(r"\b(\d{6})\b", body)
                            if m6:
                                return m6.group(1)
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(interval)
    return None


def yyds_get_messages(api_key, inbox_id, timeout=20):
    """List messages in inbox (full body optional)."""
    r = requests.get(
        f"{YYDS_BASE}/inboxes/{inbox_id}/messages",
        headers=yyds_headers(api_key), timeout=timeout)
    r.raise_for_status()
    j = r.json()
    return ((j.get("data") or {}).get("messages")
            or j.get("messages") or [])


def yyds_get_message(api_key, message_id, timeout=20):
    """Get single message with full body."""
    r = requests.get(
        f"{YYDS_BASE}/messages/{message_id}",
        headers=yyds_headers(api_key), timeout=timeout)
    r.raise_for_status()
    j = r.json()
    return (j.get("data") or j)


def yyds_list_inboxes(api_key, timeout=20):
    """List all inboxes for the key."""
    r = requests.get(f"{YYDS_BASE}/inboxes", headers=yyds_headers(api_key), timeout=timeout)
    r.raise_for_status()
    j = r.json()
    d = j.get("data") or j
    return d.get("inboxes") or d.get("items") or (d if isinstance(d, list) else [])
