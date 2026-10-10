#!/usr/bin/env python3
"""Seed kv(scope='settings', key='zaiPoolEmails') from the zcode connection rows.

Why: zai_sidecar.py used to pull its round-robin pool straight out of
`providerConnections WHERE provider='zcode' AND isActive=1`. That coupling made
the zcode rows undeactivatable — flipping isActive=0 killed the sidecar pool and
took `za/*` (the working path) down with it. The rows stay the credential store
(load_account() looks them up by email, no isActive filter), so we snapshot the
email list into kv once and the sidecar reads from there.

Usage:
  python3 seed_zai_pool.py            # snapshot active zcode rows into kv
  python3 seed_zai_pool.py --show     # print the current kv pool
  python3 seed_zai_pool.py --clear    # drop the kv key (sidecar falls back to rows)
"""
import json
import os
import sqlite3
import sys

DB = os.environ.get("ZCODE_DB", "/home/ubuntu/VansRouter/data/db/data.sqlite")
SCOPE = "settings"
KEY = "zaiPoolEmails"


def _kv_upsert(conn, value):
    cur = conn.execute("SELECT 1 FROM kv WHERE scope=? AND key=?", (SCOPE, KEY)).fetchone()
    if cur:
        conn.execute("UPDATE kv SET value=? WHERE scope=? AND key=?", (value, SCOPE, KEY))
    else:
        conn.execute("INSERT INTO kv (scope, key, value) VALUES (?,?,?)", (SCOPE, KEY, value))


def main():
    args = set(sys.argv[1:])
    conn = sqlite3.connect(DB)
    try:
        if "--show" in args:
            row = conn.execute("SELECT value FROM kv WHERE scope=? AND key=?", (SCOPE, KEY)).fetchone()
            print(row[0] if row else "(unset)")
            return
        if "--clear" in args:
            conn.execute("DELETE FROM kv WHERE scope=? AND key=?", (SCOPE, KEY))
            conn.commit()
            print("cleared", KEY)
            return
        rows = conn.execute(
            "SELECT email FROM providerConnections "
            "WHERE provider='zcode' AND isActive=1 AND email IS NOT NULL ORDER BY email"
        ).fetchall()
        emails = [r[0] for r in rows if r[0]]
        if not emails:
            print("refusing to seed: zero active zcode rows found")
            return 1
        _kv_upsert(conn, json.dumps(emails))
        conn.commit()
        print(f"seeded {KEY} with {len(emails)} emails")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
