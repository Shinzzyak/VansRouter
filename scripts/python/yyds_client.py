"""YYDS Mail API client — standalone, zero heavy deps (requests only).

Port of the yyds mail-provider functions from grokreg/_upstream.py
(originally gradle-development/grouter). Used by VansRouter as a temp-mail
provider: create inbox, poll messages, extract verification codes.

API base: https://maliapi.215.im/v1  (YYDS Mail)
Auth: X-API-Key <key>  OR  Authorization: Bearer <jwt>
"""
import re
import secrets
import string
import time

import requests

YYDS_API_BASE = "https://maliapi.215.im/v1"

_http = requests.Session()
_http.headers.update({"Accept": "application/json"})


class YYDSMailError(Exception):
    pass


def _headers(api_key="", jwt=""):
    h = {"Content-Type": "application/json"}
    if jwt:
        h["Authorization"] = f"Bearer {jwt}"
    elif api_key:
        h["X-API-Key"] = api_key
    return h


def _get(path, api_key="", jwt="", params=None, timeout=15):
    r = _http.get(f"{YYDS_API_BASE}{path}", params=params or {}, headers=_headers(api_key, jwt), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _post(path, payload, api_key="", jwt="", timeout=20):
    r = _http.post(f"{YYDS_API_BASE}{path}", json=payload, headers=_headers(api_key, jwt), timeout=timeout)
    r.raise_for_status()
    return r.json()


def yyds_get_domains(api_key="", jwt=""):
    data = _get("/domains", api_key, jwt)
    return data.get("data", []) if data.get("success") else []


def yyds_create_account(address=None, domain=None, api_key="", jwt=""):
    payload = {}
    if address:
        payload["address"] = address
    if domain:
        payload["domain"] = domain
    elif api_key or jwt:
        payload["autoDomainStrategy"] = "prefer_owned"
    data = _post("/accounts", payload, api_key, jwt)
    if data.get("success"):
        return data.get("data", {})
    raise YYDSMailError(f"YYDS create email failed: {data}")


def yyds_create_account_owned(address_prefix, domain, api_key=""):
    """Create an inbox on a SPECIFIC owned domain (scope=own API key).

    The 'Herm' key (domainScope=own) can create on the account's private
    domains (verified 2026-08-08: POST /v1/accounts with
    {\"domain\":\"zchyur.my.id\",\"address\":\"...\"} → 200 + inbox token).
    No account JWT/password needed.
    """
    if not api_key:
        raise YYDSMailError("create on owned domain requires an API key with domainScope=own")
    data = _post("/accounts", {"domain": domain, "address": address_prefix}, api_key)
    if data.get("success"):
        return data.get("data", {})
    raise YYDSMailError(f"YYDS create owned inbox failed: {data}")


def yyds_get_token(address, api_key="", jwt=""):
    # /token also requires a temp token or account JWT (API key alone → 401).
    if not jwt:
        raise YYDSMailError("get token requires an account JWT (API key alone is rejected)")
    data = _post("/token", {"address": address}, "", jwt)
    if data.get("success"):
        return data.get("data", {}).get("token")
    raise YYDSMailError(f"YYDS get token failed: {data}")


def yyds_get_messages(address, token=None, api_key="", jwt=""):
    # Auth priority: temp inbox token > account JWT > API key.
    # API key alone is NOT accepted for /messages (verified 2026-08-08:
    # returns authorization_required_any unless a temp token or JWT is sent).
    temp_token = token or jwt
    if not temp_token:
        raise YYDSMailError("messages requires a temp inbox token or account JWT")
    data = _get("/messages", "", temp_token, params={"address": address})
    if data.get("success"):
        return data.get("data", {}).get("messages", [])
    return []


def yyds_get_message_detail(message_id, token=None, api_key="", jwt=""):
    temp_token = token or jwt
    if not temp_token:
        raise YYDSMailError("message detail requires a temp inbox token or account JWT")
    data = _get(f"/messages/{message_id}", "", temp_token)
    if data.get("success"):
        return data.get("data", {})
    raise YYDSMailError(f"YYDS get message detail failed: {data}")


def yyds_generate_username(length=10):
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def yyds_pick_domain(api_key="", jwt=""):
    domains = yyds_get_domains(api_key=api_key, jwt=jwt)
    if not domains:
        raise YYDSMailError("YYDS returned no available domains")
    private = [d for d in domains if d.get("isVerified") and not d.get("isPublic")]
    if private:
        return private[0]["domain"]
    public = [d for d in domains if d.get("isVerified") and d.get("isPublic")]
    if public:
        return public[0]["domain"]
    verified = [d for d in domains if d.get("isVerified")]
    if verified:
        return verified[0]["domain"]
    raise YYDSMailError("YYDS no verified domains available")


def yyds_get_email_and_token(api_key="", jwt=""):
    """Create a fresh inbox on a verified (prefer owned) domain. Returns (address, token)."""
    if not api_key and not jwt:
        raise YYDSMailError("YYDS API Key or JWT not configured")
    domain = yyds_pick_domain(api_key=api_key, jwt=jwt)
    username = yyds_generate_username(10)
    result = yyds_create_account(address=username, domain=domain, api_key=api_key, jwt=jwt)
    address = result.get("address") or f"{username}@{domain}"
    temp_token = result.get("token")
    if not temp_token:
        temp_token = yyds_get_token(address, api_key=api_key, jwt=jwt)
    if not temp_token:
        raise YYDSMailError("Failed to get YYDS token")
    return address, temp_token


def yyds_create_owned_inbox(api_key="", domain="", address_prefix=""):
    """Create a fresh inbox on an OWNED domain (scope=own API key).

    Returns (address, token). Uses the given prefix (or random 10-char),
    pinned to the requested domain (or first private/verified domain).
    """
    if not api_key:
        raise YYDSMailError("YYDS API Key not configured")
    if not domain:
        domains = yyds_get_domains(api_key=api_key)
        private = [d for d in domains if d.get("isVerified") and not d.get("isPublic")]
        if not private:
            raise YYDSMailError("No owned/private verified domains on this API key")
        domain = private[0]["domain"]
    prefix = address_prefix or yyds_generate_username(10)
    result = yyds_create_account_owned(prefix, domain, api_key)
    address = result.get("address") or f"{prefix}@{domain}"
    temp_token = result.get("token")
    if not temp_token:
        temp_token = yyds_get_token(address, api_key=api_key, jwt="")
    if not temp_token:
        raise YYDSMailError("Failed to get YYDS token for owned inbox")
    return address, temp_token


def extract_verification_code(blob, subject=""):
    """Extract a verification code from email body/subject (same heuristics as grokreg)."""
    text = f"{subject}\n{blob}"
    patterns = [
        r"\b(\d{6})\b",
        r"\b(\d{8})\b",
        r"\b([A-Z0-9]{6})\b",
        r"\b([A-Z0-9]{8})\b",
    ]
    for p in patterns:
        m = re.search(p, text)
        if m:
            return m.group(1)
    return None


def yyds_get_oai_code(token, address, timeout=180, poll_interval=1, log_callback=None, jwt="", cancel_callback=None):
    """Poll YYDS inbox until a verification code arrives. Returns the code string."""
    deadline = time.time() + timeout
    seen_ids = set()
    while time.time() < deadline:
        if cancel_callback and cancel_callback():
            raise YYDSMailError("cancelled")
        try:
            messages = yyds_get_messages(address, token=token, jwt=jwt)
        except Exception as exc:
            if log_callback:
                log_callback(f"[Debug] YYDS fetch message list failed: {exc}")
            time.sleep(poll_interval)
            continue
        for msg in messages:
            msg_id = msg.get("id")
            if not msg_id or msg_id in seen_ids:
                continue
            seen_ids.add(msg_id)
            to_addrs = [t.get("address", "").lower() for t in (msg.get("to") or [])]
            if address.lower() not in to_addrs:
                continue
            try:
                detail = yyds_get_message_detail(msg_id, token=token, jwt=jwt)
            except Exception as exc:
                if log_callback:
                    log_callback(f"[Debug] YYDS get message detail failed: {exc}")
                continue
            parts = []
            text_body = detail.get("text") or ""
            if text_body:
                parts.append(text_body)
            html_list = detail.get("html") or []
            for h in html_list:
                parts.append(re.sub(r"<[^>]+>", " ", h))
            combined = "\n".join(parts)
            subject = detail.get("subject", "")
            if log_callback:
                log_callback(f"[Debug] YYDS received email: {subject}")
            code = extract_verification_code(combined, subject)
            if code:
                if log_callback:
                    log_callback(f"[*] YYDS extracted verification code from email: {code}")
                return code
        time.sleep(poll_interval)
    raise YYDSMailError(f"YYDS did not receive verification email within {timeout}s")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="YYDS Mail CLI — create inbox + poll OTP")
    ap.add_argument("--api-key", default="")
    ap.add_argument("--jwt", default="")
    ap.add_argument("cmd", choices=["domains", "create", "create-owned", "poll"])
    ap.add_argument("--address", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--domain", default="")
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args()

    if args.cmd == "domains":
        for d in yyds_get_domains(args.api_key, args.jwt):
            print(f"{d.get('domain')} | verified={d.get('isVerified')} public={d.get('isPublic')} mx={d.get('isMxValid')}")
    elif args.cmd == "create":
        addr, tok = yyds_get_email_and_token(args.api_key, args.jwt)
        print(f"ADDRESS={addr}")
        print(f"TOKEN={tok}")
    elif args.cmd == "create-owned":
        addr, tok = yyds_create_owned_inbox(api_key=args.api_key, domain=args.domain, address_prefix=args.address)
        print(f"ADDRESS={addr}")
        print(f"TOKEN={tok}")
    elif args.cmd == "poll":
        if not args.address or not args.token:
            raise SystemExit("poll requires --address and --token")
        code = yyds_get_oai_code(args.token, args.address, timeout=args.timeout)
        print(f"CODE={code}")
