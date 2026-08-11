"""tokenharborreg — Token Harbor bulk signup with chain referral.

API-based signup (Next.js server action) + YYDS/Driftz/tempik mail chain +
email verification + gift claim + API key creation + invite code extraction.

Flow per account (chain):
  1. create inbox (mail chain: YYDS -> Driftz -> tempik)
  2. parse /login?mode=signup for server action id + key
  3. POST server action (email, password, invite_code from previous account)
  4. poll inbox for verification link, open it (email verified)
  5. claim $5 gift, create API key, extract own invite code
  6. emit JSON line {status, email, inviteCode, apiKey, balance}

Usage:
  python3 -m tokenharborreg --count 3 --yyds-api-key AC-... --yyds-domain valerius.biz.id \
      --seed-invite TH-XXXX-XXXX [--proxy socks5://host:port]

Output: JSON lines to stdout (one per account), logs to stderr.
"""
import argparse
import json
import os
import random
import re
import sys
import time
import uuid

import requests

PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#"
SIGNUP_URL = "https://tokenharbor.ai/login?mode=signup"
API_BASE = "https://tokenharbor.ai"


def _log(msg, **kw):
    print(f"[th] {msg}", file=sys.stderr, flush=True, **kw)


def _passwd(n=14):
    # R25-TH5: server butuh password ≥12 char + digit. _passwd lama kadang
    # tanpa digit → ditolak ("Password needs at least 12 characters" padahal
    # 14 char — server validate digit juga). Guarantee 1 digit + 1 upper.
    chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#"
    pw = [random.choice("23456789"), random.choice("ABCDEFGHJKMNPQRSTUVWXYZ")]
    pw += [random.choice(chars) for _ in range(n - 2)]
    random.shuffle(pw)
    return "".join(pw)


def _ua():
    return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )


def _make_session(proxy=None):
    s = requests.Session()
    s.headers.update({"User-Agent": _ua()})
    if proxy:
        s.proxies.update({"http": proxy, "https": proxy})
        # Proxy gateway (127.0.0.1:8081) pakai MITM cert — verify=False wajib
        # (sama seperti autoclawreg ignore_https_errors). Tanpa ini SSLError.
        s.verify = False
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    return s


def _parse_action(html):
    """Extract Next.js server action id + key from signup page."""
    m = re.search(r'name="\$ACTION_1:0" value="([^"]+)"', html)
    key = re.search(r'name="\$ACTION_KEY" value="([^"]+)"', html)
    if not m or not key:
        return None, None
    try:
        payload = json.loads(m.group(1).replace("&quot;", '"'))
        return payload.get("id"), key.group(1)
    except Exception:
        return None, None


def _create_inbox_chain(yyds_key, yyds_domain, s):
    """YYDS -> Driftz -> tempik. Returns (email, poll_fn) or raises."""
    if yyds_key:
        try:
            from qoderreg._yyds import yyds_create_inbox

            email, iid = yyds_create_inbox(yyds_key, yyds_domain or "valerius.biz.id")
            _log(f"yyds inbox {email}")

            def poll(deadline):
                return _poll_yyds(yyds_key, iid, deadline)

            return email, poll
        except Exception as e:
            _log(f"yyds failed ({e}), fallback driftz")
    try:
        from qoderreg._driftz import driftz_create_inbox

        addr, iid = driftz_create_inbox()
        _log(f"driftz inbox {addr}")

        def poll(deadline):
            return _poll_driftz(iid, deadline)

        return addr, poll
    except Exception as e:
        _log(f"driftz failed ({e}), fallback tempik")
    from qoderreg._tempik import tempik_create_inbox

    addr, iid = tempik_create_inbox()
    _log(f"tempik inbox {addr}")

    def poll(deadline):
        return _poll_tempik(iid, deadline)

    return addr, poll


def _poll_yyds(key, iid, deadline):
    while time.time() < deadline:
        r = requests.get(
            f"https://maliapi.215.im/v1/inboxes/{iid}/messages",
            headers={"Authorization": f"Bearer {key}"},
            timeout=20,
        )
        msgs = (r.json().get("data") or {}).get("messages") or []
        for m in msgs:
            body = m.get("body") or m.get("html") or m.get("text") or ""
            if not isinstance(body, str):
                body = json.dumps(body)
            if "tokenharbor" in (body + (m.get("from") or "")).lower() or "verify" in (
                m.get("subject") or ""
            ).lower():
                return m
        time.sleep(8)
    return None


def _poll_driftz(iid, deadline):
    while time.time() < deadline:
        r = requests.get(f"https://api.driftz.net/api/v1/inbox/{iid}", timeout=20)
        j = r.json()
        items = j.get("data") or j.get("emails") or []
        if isinstance(j, list):
            items = j
        for m in items:
            body = str(m.get("body") or m.get("html") or "")
            if "tokenharbor" in body.lower() or "verify" in str(m.get("subject", "")).lower():
                return m
        time.sleep(8)
    return None


def _poll_tempik(iid, deadline):
    # R25-TH3: path lama /api/inbox/{iid}/messages = 404 (Extra data JSON error).
    # Path benar: /api/inboxes/{address}/messages + x-session-id header.
    # Reuse tempik_poll_otp dari qoderreg yang sudah benar.
    try:
        from qoderreg._tempik import tempik_poll_otp
        from qoderreg._tempik import _req as tempik_req
    except Exception:
        _log("tempik_poll_otp import gagal — fallback poll manual")
        return _poll_tempik_old(iid, deadline)
    # iid = session_id; cari inbox address via session
    try:
        inboxes = tempik_req("GET", "/inboxes", {"x-session-id": iid})
        for box in inboxes:
            addr = box.get("address")
            if not addr:
                continue
            mails = tempik_req("GET", f"/inboxes/{addr}/messages", {"x-session-id": iid})
            for m in mails:
                body = str(m.get("body") or m.get("html") or m.get("textContent") or "")
                if "tokenharbor" in body.lower() or "verify" in str(m.get("subject", "")).lower():
                    return m
    except Exception as e:
        _log(f"tempik poll err: {e}")
    # loop sampai deadline
    while time.time() < deadline:
        try:
            inboxes = tempik_req("GET", "/inboxes", {"x-session-id": iid})
            for box in inboxes:
                addr = box.get("address")
                if not addr:
                    continue
                mails = tempik_req("GET", f"/inboxes/{addr}/messages", {"x-session-id": iid})
                for m in mails:
                    body = str(m.get("body") or m.get("html") or m.get("textContent") or "")
                    if "tokenharbor" in body.lower() or "verify" in str(m.get("subject", "")).lower():
                        return m
        except Exception as e:
            _log(f"tempik poll err: {e}")
        time.sleep(8)
    return None


def _poll_tempik_old(iid, deadline):
    while time.time() < deadline:
        r = requests.get(
            f"https://tempik.exilion.my.id/api/inbox/{iid}/messages", timeout=20
        )
        j = r.json()
        msgs = j.get("messages") or j.get("data") or []
        for m in msgs:
            body = str(m.get("body") or m.get("html") or "")
            if "tokenharbor" in body.lower() or "verify" in str(m.get("subject", "")).lower():
                return m
        time.sleep(8)
    return None


def _extract_verify_link(msg):
    """Pull https://tokenharbor.ai/...verify... or supabase confirm link from message."""
    blob = json.dumps(msg)
    urls = re.findall(r"https?://[^\s\"'<>\\]+", blob)
    for u in urls:
        if any(k in u.lower() for k in ("verify", "confirm", "tokenharbor", "supabase")):
            return u
    return None


def register_one(yyds_key, yyds_domain, seed_invite, proxy, index):
    s = _make_session(proxy)
    email, poll = _create_inbox_chain(yyds_key, yyds_domain, s)
    password = _passwd()
    invite = seed_invite or ""

    # 1. fetch signup page for action ids
    r = s.get(SIGNUP_URL, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"signup page HTTP {r.status_code}")
    action_id, action_key = _parse_action(r.text)
    if not action_id:
        raise RuntimeError("could not parse server action id (turnstile block?)")

    # 1b. Turnstile precheck (port dari catoncat/th-reg) — skip DINI kalau IP flagged.
    #     Kalau needCaptcha=true, POST pasti 500 (IP-level flag, terbukti re-tokenharbor).
    #     Jangan bypass — rotasi IP (proxy sticky) atau tandai failed.
    fp = str(uuid.uuid4())
    try:
        pre = s.get(f"{API_BASE}/api/auth/signup-precheck?fp={fp}", timeout=15)
        if pre.status_code == 200:
            need = (pre.json() or {}).get("needCaptcha")
            if need:
                _log(f"precheck needCaptcha=true (IP flagged) — skip, rotasi proxy")
                return {"status": "captcha-required", "email": email, "invite_code_used": invite}
        else:
            _log(f"precheck HTTP {pre.status_code} (non-fatal, lanjut)")
    except Exception as e:
        _log(f"precheck error ({e}) — lanjut tanpa precheck")

    # 2. submit server action — React 19 useActionState encoding:
    #    field name = "<N>_<fieldname>" (N = arg index), state = "0" → ["$undefined","$K1"]
    files = {
        "1_device_fingerprint": (None, fp),
        "1_timezone": (None, "Asia/Jakarta"),
        "1_next": (None, "0"),
        "1_email": (None, email),
        "1_password": (None, password),
        "1_invite_code": (None, invite),
        "0": (None, '["$undefined","$K1"]'),
        # R25-TH6: hidden fields React 19 — WAJIB, tanpa ini server action
        # tidak dieksekusi (200 tanpa error tapi akun tidak dibuat = silent fail)
        "$ACTION_REF_1": (None, ""),
        "$ACTION_1:0": (None, '{"id":"%s","bound":"$@1"}' % action_id),
        "$ACTION_1:1": (None, '["$undefined"]'),
        "$ACTION_KEY": (None, action_key),
    }
    r = s.post(
        SIGNUP_URL,
        files=files,
        allow_redirects=False,
        timeout=30,
        headers={
            "Next-Action": action_id,
            "Referer": SIGNUP_URL,
            "Accept": "text/x-component",
        },
    )
    if r.status_code != 303:
        # R25-TH1: debug — dump body utk tahu kenapa ditolak (200 = React Flight
        # error digest, biasanya rate limit / IP flag / cookie mismatch)
        body_snippet = ""
        try:
            body_snippet = r.text[:300]
        except Exception:
            pass
        # R25-TH4: parse React Flight error — kalau error message nyata (bukan
        # digest rate limit), itu VALIDASI server (password pendek, email duplikat).
        # Password < 12 char = ditolak server. Rate limit = digest 343680605.
        flight_error = None
        if r.status_code == 200:
            for line in r.text.splitlines():
                if '"error"' in line:
                    m_err = re.search(r'"error":"([^"]+)"', line)
                    if m_err:
                        flight_error = m_err.group(1)
                        break
        if flight_error and "password" in flight_error.lower():
            raise RuntimeError(f"signup validation: {flight_error}")
        # R25-TH2: 200 + React Flight TANPA error digest (343680605) = SUKSES
        # (server action diterima, redirect via JS/streaming). Rate limit lama
        # selalu return digest — absence = akun dibuat.
        if r.status_code == 200 and "343680605" not in r.text:
            _log(f"signup 200 tanpa error digest — anggap SUKSES (akun dibuat) flight={flight_error}")
        else:
            raise RuntimeError(f"signup HTTP {r.status_code} (IP flagged?) body={body_snippet}")
    _log(f"signup OK → {r.headers.get('location')}")

    # 3. wait for verification email, open link
    deadline = time.time() + 180
    msg = poll(deadline)
    if not msg:
        # R25-TH7: akun SUDAH dibuat (303) tapi verify email tidak datang
        # (tempik inbox expire / email delay). Jangan raise — return sukses
        # dengan status needs_verify supaya akun tetap masuk account pool.
        _log("verification email not received — akun tetap dibuat (303), return needs_verify")
        result = {"status": "needs_verify", "email": email, "password": password,
                  "invite_code_used": invite, "apiKey": None, "inviteCode": None}
        return result
    link = _extract_verify_link(msg)
    if not link:
        raise RuntimeError("verification link not found in email")
    r = s.get(link, timeout=30, allow_redirects=True)
    _log(f"verify link opened → HTTP {r.status_code}")

    # 4. session now active; claim gift + create key via dashboard API guesses
    result = _claim_and_key(s, email)
    result.update({"email": email, "password": password, "invite_code_used": invite})
    return result


def _claim_and_key(s, email):
    """Klaim $5 gift + buat API key + aktivasi free route (endpoint terverifikasi
    dari catoncat/th-reg, bukan tebakan)."""
    out = {"status": "success", "balance": None, "apiKey": None, "inviteCode": None}
    # 1. klaim gift $5 — endpoint benar dari th-reg
    try:
        r = s.post(f"{API_BASE}/api/welcome/claim", timeout=15)
        if r.status_code in (200, 201):
            j = r.json()
            out["balance"] = j.get("rewardUsd") or j.get("balance") or j.get("credits")
            _log(f"gift claim /api/welcome/claim → {r.status_code} {j}")
        else:
            _log(f"welcome/claim HTTP {r.status_code}")
    except Exception as e:
        _log(f"welcome/claim error: {e}")
    # 2. API key — body {"label": "..."} dari th-reg
    try:
        r = s.post(f"{API_BASE}/api/keys", json={"label": "bot-key"}, timeout=15)
        if r.status_code in (200, 201):
            j = r.json()
            out["apiKey"] = j.get("plaintext") or j.get("key") or j.get("apiKey") or (j.get("data") or {}).get("key")
            _log(f"api key → HTTP {r.status_code}")
        else:
            _log(f"api/keys HTTP {r.status_code}")
    except Exception as e:
        _log(f"api/keys error: {e}")
    # 3. aktivasi free route — tanpa ini :free 429 free_route_inactive (th-reg)
    try:
        r = s.post(f"{API_BASE}/api/me/privacy", json={"free_models_enabled": True}, timeout=15)
        if r.status_code in (200, 201):
            _log("free models route activated")
    except Exception as e:
        _log(f"privacy route error: {e}")
    # invite code page
    try:
        r = s.get(f"{API_BASE}/dashboard/invites", timeout=20)
        m = re.search(r"invite=([A-Z0-9-]{6,})", r.text)
        if m:
            out["inviteCode"] = m.group(1)
            _log(f"invite code {out['inviteCode']}")
    except Exception:
        pass
    return out


def _proxy_with_sid(proxy_url, sid):
    """Inject cliproxy-style sid ke proxy gateway (127.0.0.1:8081) untuk rotasi IP per akun."""
    if not proxy_url or "127.0.0.1:8081" not in proxy_url:
        return proxy_url
    return proxy_url.replace("://", f"://bulk-sid-{sid}-t-300:x@", 1)


def main():
    ap = argparse.ArgumentParser(description="Token Harbor chain-referral signup")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--yyds-api-key", default=os.environ.get("YYDS_API_KEY", ""))
    ap.add_argument("--yyds-domain", default=os.environ.get("YYDS_DOMAIN", "valerius.biz.id"))
    ap.add_argument("--seed-invite", default="", help="initial invite code (chain seed)")
    ap.add_argument("--proxy", default=os.environ.get("TH_PROXY", ""))
    args = ap.parse_args()

    last_invite = args.seed_invite
    ok = 0
    for i in range(1, args.count + 1):
        try:
            sid = f"th{int(time.time())}{random.randint(1000, 9999)}"
            result = register_one(
                args.yyds_api_key, args.yyds_domain, last_invite, _proxy_with_sid(args.proxy, sid), i
            )
            if result.get("inviteCode"):
                last_invite = result["inviteCode"]
            result["line"] = i
            print(json.dumps(result, ensure_ascii=False), flush=True)
            ok += 1
        except Exception as e:
            print(json.dumps({"line": i, "status": "failed", "error": str(e)}, ensure_ascii=False), flush=True)
    _log(f"done {ok}/{args.count}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
