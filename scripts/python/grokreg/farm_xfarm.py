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
    ap.add_argument("--proxy-file", default=None, help="file proxy list (rotate antar akun; format host:port per baris)")
    ap.add_argument("--proxy-mode", default="limit", choices=["limit", "every"], help="limit=sticky sampai 429/block; every=rotate tiap N")
    ap.add_argument("--proxy-every", type=int, default=5, help="rotate tiap N akun (mode every)")
    ap.add_argument("--delay", type=float, default=None, help="delay antar akun (detik)")
    ap.add_argument("--auth-mode", default="email", choices=["email", "google", "sso"], help="mode auth (sso=reuse SSO cookie dari DB)")
    ap.add_argument("--sso-reuse", default=None, help="email pemilik SSO utk --auth-mode sso (device flow reuse)")
    ap.add_argument("--relay", default=None, help="Vercel relay URL (egress via relay, rotation IP)")
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
    if args.proxy_file:
        cmd += ["--proxy-file", args.proxy_file, "--proxy-mode", args.proxy_mode, "--proxy-every", str(args.proxy_every)]
    if args.delay:
        cmd += ["--delay", str(args.delay)]
    if args.skip_inject:
        cmd.append("--skip-inject")
    if args.auth_mode != "email":
        cmd += ["--auth-mode", args.auth_mode]
    if args.sso_reuse:
        cmd += ["--sso-reuse", args.sso_reuse]
    if args.relay:
        cmd += ["--relay", args.relay]

    env = dict(os.environ)
    env["NINEROUTER_DB"] = args.db
    print(f"[grokreg-farm] cd {XFARM_DIR} && {' '.join(cmd)}")
    return subprocess.call(cmd, cwd=XFARM_DIR, env=env)


if __name__ == "__main__":
    sys.exit(main())
