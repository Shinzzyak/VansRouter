#!/usr/bin/env python3
"""
grokreg x-farm bridge — pakai engine x-farm (pure HTTP, turnstile local, inject 9router).

Grok farming automation v2: x-farm (elzanom) proven bekerja 2026-08-13.
Jalankan via:
  python3 -m grokreg.farm_xfarm [--count N] [--workers W] [--proxy URL] [--db PATH]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

XFARM_DIR = os.environ.get("XFARM_DIR", "/home/ubuntu/x-farm")


def main() -> int:
    ap = argparse.ArgumentParser(description="grokreg x-farm bridge")
    ap.add_argument("-n", "--count", type=int, default=5, help="jumlah akun")
    ap.add_argument("-w", "--workers", type=int, default=2, help="parallel workers")
    ap.add_argument(
        "--proxy",
        default=os.environ.get("PROXY_URL") or "http://127.0.0.1:40000",
        help="proxy (default WARP 40000)",
    )
    ap.add_argument("--db", default=os.environ.get("NINEROUTER_DB") or "/home/ubuntu/VansRouter/data/db/data.sqlite")
    ap.add_argument("--mail-provider", default="mail.tm")
    ap.add_argument("--speed", default="slow", choices=["slow", "normal", "fast", "maximum"])
    ap.add_argument("--skip-inject", action="store_true", help="jangan inject ke 9router DB")
    args = ap.parse_args()

    if not os.path.isdir(XFARM_DIR):
        print(f"ERROR: x-farm tidak ada di {XFARM_DIR}. Clone: git clone https://github.com/elzanom/x-farm")
        return 1

    cmd = [
        sys.executable, "mass_regist.py",
        "-n", str(args.count),
        "-w", str(args.workers),
        "--speed", args.speed,
        "--proxy", args.proxy,
        "--mail-provider", args.mail_provider,
    ]
    if args.skip_inject:
        cmd.append("--skip-inject")

    env = dict(os.environ)
    env["NINEROUTER_DB"] = args.db
    print(f"[grokreg-farm] cd {XFARM_DIR} && {' '.join(cmd)}")
    return subprocess.call(cmd, cwd=XFARM_DIR, env=env)


if __name__ == "__main__":
    sys.exit(main())
