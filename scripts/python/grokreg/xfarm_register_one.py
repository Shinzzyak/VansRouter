#!/usr/bin/env python3
"""x-farm single registration wrapper → JSON result for GrokBulkImportManager.

Runs mass_regist for ONE account with inject enabled, then reads the freshest
grok-cli row from the 9router DB and emits JSON on stdout:

  {"status":"success","email":...,"access_token":...,"refresh_token":...,"password":...}
  {"status":"needs_retry","error":...} / {"status":"cancelled",...}

Usage: python3 xfarm_register_one.py [--proxy URL] [--mail-provider yyds] [--db PATH]
Env: YYDS_API_KEY / YYDS_JWT (mail), NINEROUTER_DB (db path)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

XFARM_DIR = os.environ.get("XFARM_DIR", "/home/ubuntu/x-farm")
DEFAULT_DB = os.environ.get("NINEROUTER_DB") or "/home/ubuntu/VansRouter/data/db/data.sqlite"
TOKEN_RE = re.compile(r"(?:xai-|eyJ)[A-Za-z0-9_\-\.]+")


def last_grok_cli(db_path: str, before_ts: float, email_hint: str = ""):
    """Return the newest grok-cli row inserted after before_ts."""
    try:
        conn = sqlite3.connect(db_path)
        rows = conn.execute(
            "SELECT email, data, createdAt FROM providerConnections "
            "WHERE provider='grok-cli' AND isActive=1 ORDER BY createdAt DESC LIMIT 5"
        ).fetchall()
        conn.close()
    except Exception as exc:
        return None, f"db read failed: {exc}"
    for email, data_json, created in rows:
        created_ts = 0
        try:
            created_ts = float(created) if created else 0
        except (TypeError, ValueError):
            created_ts = 0
        if isinstance(created, str) and created.endswith("Z"):
            try:
                from datetime import datetime, timezone
                created_ts = datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
            except Exception:
                pass
        if created_ts > before_ts:
            try:
                data = json.loads(data_json) if isinstance(data_json, str) else (data_json or {})
            except Exception:
                data = {}
            if email_hint and email_hint not in str(email):
                continue
            return {"email": email, **data}, None
    return None, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy", default=os.environ.get("PROXY_URL") or "http://127.0.0.1:40000")
    ap.add_argument("--mail-provider", default="yyds")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--speed", default="slow")
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    before = time.time()
    cmd = [
        sys.executable, os.path.join(XFARM_DIR, "mass_regist.py"),
        "-n", "1", "-w", "1",
        "--speed", args.speed,
        "--proxy", args.proxy,
        "--mail-provider", args.mail_provider,
    ]
    env = dict(os.environ)
    env["NINEROUTER_DB"] = args.db
    env["PYTHONUNBUFFERED"] = "1"
    try:
        proc = subprocess.run(
            cmd, cwd=XFARM_DIR, env=env, capture_output=True, text=True,
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"status": "needs_retry", "error": "x-farm timeout"}))
        return 1

    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if "TOKEN ok" in out or "injected grok-cli" in out:
        row, err = last_grok_cli(args.db, before)
        if row:
            access = row.get("accessToken") or row.get("access_token") or ""
            refresh = row.get("refreshToken") or row.get("refresh_token") or ""
            if access:
                print(json.dumps({
                    "status": "success",
                    "email": row.get("email", ""),
                    "password": row.get("password", ""),
                    "sso": row.get("sso", ""),
                    "access_token": access,
                    "refresh_token": refresh,
                }))
                return 0
        print(json.dumps({"status": "needs_retry", "error": "token ok but DB row missing"}))
        return 1

    if "CANCELLED" in out:
        print(json.dumps({"status": "cancelled", "error": "cancelled"}))
        return 0
    m = re.search(r"FAIL hard: (.+)", out)
    err = m.group(1).strip() if m else (out.strip().splitlines() or ["x-farm failed"])[-1][:300]
    print(json.dumps({"status": "needs_retry", "error": err}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
