"""Baseten HTTP continuation: session from browser cookies → waiting room →
approve → onboarding → API key. Pure requests, mirrors harvest-console src/graphql.py
calls (endpoints observed in baseten_action_extract.py + patch fragments)."""
import re

import requests

API_BASE = "https://app.baseten.co"
AUTH_BASE = "https://login.baseten.co"
CLIENT_ID = "client_01GFS4WX73TQ4NQJPQ9EPCYQY7"
REDIRECT_URI = "https://app.baseten.co/api/"
SIGNUP_URL = f"{AUTH_BASE}/sign-up?client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def make_session(proxy=None):
    s = requests.Session()
    s.headers.update({"User-Agent": _UA})
    if proxy:
        s.proxies.update({"http": proxy, "https": proxy})
    return s


def _gql(q):
    """GraphQL POST helper (harvest-console used src/graphql.py; body shape best-effort)."""
    return {
        "query": q,
        "operationName": None,
        "variables": {},
    }


def submit_waiting_room(s, first, last, organization="bt"):
    r = s.post(
        f"{API_BASE}/api/graphql",
        json=_gql(
            "mutation { submitWaitingRoom(input: {firstName: \"%s\", lastName: \"%s\", "
            "organization: \"%s\"}) { success } }" % (first, last, organization)
        ),
        timeout=20,
    )
    return r


def get_user(s):
    r = s.post(
        f"{API_BASE}/api/graphql",
        json=_gql("{ viewer { id status firstName lastName organization } }"),
        timeout=20,
    )
    try:
        return (r.json().get("data") or {}).get("viewer") or {}
    except Exception:
        return {}


def complete_onboarding(s, first, last, organization="bt"):
    try:
        s.post(
            f"{API_BASE}/api/graphql",
            json=_gql(
                "mutation { completeOnboarding(input: { firstName: \"%s\", lastName: \"%s\", "
                "organization: \"%s\" }) { success } }" % (first, last, organization)
            ),
            timeout=20,
        )
    except Exception:
        pass


def create_api_key(s, name="bt"):
    """Create API key. Try GraphQL mutation, then dashboard REST guesses."""
    try:
        r = s.post(
            f"{API_BASE}/api/graphql",
            json=_gql(
                'mutation { createApiKey(input: { name: "%s" }) { apiKey { id key name createdAt } } }'
                % name
            ),
            timeout=20,
        )
        j = r.json()
        key = (
            (j.get("data") or {}).get("createApiKey", {}).get("apiKey", {}).get("key")
        )
        if key:
            return key
    except Exception:
        pass
    for path in ("/api/keys", "/api/api_keys", "/api/dashboard/api-keys"):
        try:
            r = s.post(f"{API_BASE}{path}", json={"name": name}, timeout=15)
            if r.status_code in (200, 201):
                j = r.json()
                key = j.get("key") or j.get("apiKey") or (j.get("data") or {}).get("key")
                if key:
                    return key
        except Exception:
            continue
    # last resort: scan dashboard HTML for a key-shaped token
    try:
        r = s.get(f"{API_BASE}/api/", timeout=20)
        m = re.search(r"\b(bt_[A-Za-z0-9_\-]{20,})\b", r.text)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None
