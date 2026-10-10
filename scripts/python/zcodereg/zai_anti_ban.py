#!/usr/bin/env python3
"""Anti-ban + pacing guards for the ZAI (chat.z.ai) UI-driven sidecar.

Same job as the DeepSeek bridge's anti_ban.py, adapted to a BROWSER-driven
provider. The failure modes are different in one important way: here the
expensive, fingerprintable act is *launching a browser against chat.z.ai*, not
just the HTTP call. So the guards have to cover concurrency as well as rate.

Failure modes handled:

1. PARALLEL BROWSER STORMS — each request launches a fresh Camoufox (~250-400MB
   on a 3.7GB box). Two concurrent requests already put the machine under memory
   pressure, and N simultaneous logins from one IP is itself a farm signal.
   Guarded by a global semaphore of 1 (SIDECAR_MAX_CONCURRENT).

2. BURST — many chats from one account in a short window. Guarded by a per-account
   rolling-hour ceiling, checked before the browser is launched.

3. HOT RETRY ON A FAILING ACCOUNT — a dead/expired account keeps getting picked
   because selection is round-robin. Guarded by escalating cooldown per account,
   so a failing account is parked instead of retried.

Env overrides:
  ZAI_MAX_REQ_PER_ACCOUNT_HOUR (default 30)
  ZAI_MAX_CONCURRENT           (default 1)
  ZAI_ERROR_BACKOFF_BASE_SEC   (default 120)
  ZAI_ERROR_BACKOFF_MAX_SEC    (default 1800)
"""
from __future__ import annotations

import os
import threading
import time

MAX_REQ_PER_ACCOUNT_HOUR = int(os.environ.get("ZAI_MAX_REQ_PER_ACCOUNT_HOUR", "30"))
MAX_CONCURRENT = int(os.environ.get("ZAI_MAX_CONCURRENT", "1"))
ERROR_BACKOFF_BASE_SEC = float(os.environ.get("ZAI_ERROR_BACKOFF_BASE_SEC", "120"))
ERROR_BACKOFF_MAX_SEC = float(os.environ.get("ZAI_ERROR_BACKOFF_MAX_SEC", "1800"))

_lock = threading.RLock()
_hourly: dict[str, list[float]] = {}     # account -> recent request timestamps
_cooldown: dict[str, float] = {}         # account -> unix ts until parked
_fails: dict[str, int] = {}              # account -> consecutive failures

# One browser at a time. Serialising is both the RAM fix and the ban fix.
BROWSER_GATE = threading.Semaphore(MAX_CONCURRENT)


def _prune(now: float, stamps: list[float]) -> list[float]:
    cutoff = now - 3600.0
    return [t for t in stamps if t > cutoff]


def allow_request(account_label: str) -> tuple[bool, str]:
    """Reserve a chat slot for this account. (allowed, reason_if_not).

    Called BEFORE the browser launches, so a throttled account costs no RAM.
    """
    now = time.time()
    with _lock:
        until = _cooldown.get(account_label, 0.0)
        if until > now:
            return False, f"account cooling down ({int(until - now)}s left, {_fails.get(account_label, 0)} fails)"
        stamps = _prune(now, _hourly.get(account_label, []))
        if len(stamps) >= MAX_REQ_PER_ACCOUNT_HOUR:
            _hourly[account_label] = stamps
            return False, f"hourly cap reached ({len(stamps)}/{MAX_REQ_PER_ACCOUNT_HOUR})"
        stamps.append(now)
        _hourly[account_label] = stamps
        return True, ""


def note_result(account_label: str, ok: bool) -> None:
    """Record an outcome so a failing account is parked rather than retried hot."""
    with _lock:
        if ok:
            _fails[account_label] = 0
            _cooldown.pop(account_label, None)
            return
        n = _fails.get(account_label, 0) + 1
        _fails[account_label] = n
        backoff = min(ERROR_BACKOFF_BASE_SEC * (2 ** (n - 1)), ERROR_BACKOFF_MAX_SEC)
        _cooldown[account_label] = time.time() + backoff


def usage(account_label: str) -> int:
    with _lock:
        return len(_prune(time.time(), _hourly.get(account_label, [])))


def stats() -> dict:
    now = time.time()
    with _lock:
        return {
            "per_account_last_hour": {k: len(_prune(now, v)) for k, v in _hourly.items()},
            "cooldown_until": {k: v for k, v in _cooldown.items() if v > now},
            "consecutive_fails": dict(_fails),
            "max_req_per_account_hour": MAX_REQ_PER_ACCOUNT_HOUR,
            "max_concurrent": MAX_CONCURRENT,
        }
