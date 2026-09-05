#!/usr/bin/env python3
"""Authenticate one Antigravity account through the agy OAuth UI flow."""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

from camoufox import Camoufox

DEFAULT_PROXY = "socks5://127.0.0.1:40000"
DEFAULT_AGY = str(Path.home() / ".local/bin/agy")
TOKEN_DIR = Path(os.environ.get("AG_TOKEN_DIR", str(Path.home() / ".gemini/antigravity-cli")))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("email", nargs="?")
    parser.add_argument("password", nargs="?")
    parser.add_argument("--input", help="JSON file containing email and password")
    parser.add_argument("--proxy", default=os.environ.get("AG_PROXY", DEFAULT_PROXY))
    parser.add_argument("--agy", default=os.environ.get("AGY_BIN", DEFAULT_AGY))
    return parser.parse_args()


def load_account(args):
    if args.input:
        with open(args.input, encoding="utf-8") as handle:
            data = json.load(handle)
        return str(data["email"]), str(data["password"])
    if not args.email or args.password is None:
        raise SystemExit("usage: antigravity_auth.py EMAIL PASSWORD [--proxy URL]")
    return args.email, args.password


def read_new_text(path, offset):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            handle.seek(offset)
            text = handle.read()
            return text, handle.tell()
    except FileNotFoundError:
        return "", offset


def main():
    args = parse_args()
    email, password = load_account(args)
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    token_files_before = set(TOKEN_DIR.glob("antigravity-oauth-token*"))
    log_path = Path(f"/tmp/ag_pty_{os.getpid()}.log")
    log_path.unlink(missing_ok=True)

    state = {"ready": False, "auth_url": "", "code": "", "error": ""}

    def warm_browser():
        try:
            with Camoufox(headless=True, proxy={"server": args.proxy}, geoip=True) as browser:
                page = browser.new_page()
                state["ready"] = True
                deadline = time.time() + 90
                while not state["auth_url"] and time.time() < deadline:
                    time.sleep(0.2)
                if not state["auth_url"]:
                    raise RuntimeError("auth URL was not received")
                page.goto(state["auth_url"], wait_until="domcontentloaded", timeout=60000)
                page.wait_for_selector("#identifierId", timeout=45000)
                page.fill("#identifierId", email)
                page.keyboard.press("Enter")
                page.wait_for_timeout(1800)
                page.wait_for_selector('input[type="password"]', timeout=30000)
                page.fill('input[type="password"]', password)
                page.keyboard.press("Enter")
                page.wait_for_timeout(1800)

                native_deadline = time.time() + 30
                while "nativeapp" not in page.url and time.time() < native_deadline:
                    page.wait_for_timeout(600)
                for label in ("Login", "Sign in", "Masuk", "Log in", "Continue", "Lanjut"):
                    try:
                        button = page.get_by_role("button", name=re.compile(rf"^{re.escape(label)}$", re.I))
                        if button.count():
                            button.first.click(timeout=2000)
                            break
                    except Exception:
                        continue

                code_deadline = time.time() + 30
                while time.time() < code_deadline:
                    body = page.evaluate("document.body ? document.body.innerText : ''")
                    match = re.search(r"4/0[A-Za-z0-9_\-/]+", body)
                    if match:
                        state["code"] = match.group(0)
                        return
                    page.wait_for_timeout(600)
                raise RuntimeError("OAuth callback code was not found")
        except Exception as exc:
            state["error"] = f"browser: {type(exc).__name__}: {exc}"

    browser_thread = threading.Thread(target=warm_browser, name="antigravity-browser", daemon=True)
    browser_thread.start()
    ready_deadline = time.time() + 90
    while not state["ready"] and not state["error"] and time.time() < ready_deadline:
        time.sleep(0.2)
    if state["error"]:
        print(state["error"], flush=True)
        return 1
    if not state["ready"]:
        print("browser did not become ready", flush=True)
        return 1

    command = f"{shlex.quote(args.agy)} -p 'say OK' --output-format json"
    proc = subprocess.Popen(
        ["script", "-qefc", command, str(log_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    offset = 0
    auth_deadline = time.time() + 60
    while time.time() < auth_deadline and not state["auth_url"]:
        appended, offset = read_new_text(log_path, offset)
        cleaned = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", appended)
        match = re.search(r"https://accounts\.google\.com/o/oauth2/auth\S+", cleaned)
        if match:
            state["auth_url"] = match.group(0).rstrip("\r\n'\" )")
            print("AUTH_URL_RECEIVED", flush=True)
            break
        if proc.poll() is not None:
            break
        time.sleep(0.2)

    if not state["auth_url"]:
        print("NO_AUTH_URL", flush=True)
        proc.kill()
        browser_thread.join(timeout=5)
        return 1

    browser_thread.join(timeout=130)
    if not state["code"]:
        print(state["error"] or "NO_CODE", flush=True)
        if proc.poll() is None:
            proc.kill()
        return 1

    print(f"GOT_CODE length={len(state['code'])}", flush=True)
    try:
        proc.stdin.write(state["code"] + "\n")
        proc.stdin.flush()
    except (BrokenPipeError, OSError):
        print("PIPE_CLOSED", flush=True)
        return 1

    finish_deadline = time.time() + 60
    while proc.poll() is None and time.time() < finish_deadline:
        time.sleep(0.5)
    if proc.poll() is None:
        proc.kill()
        print("AGY_TIMEOUT", flush=True)
        return 1

    token_files_after = set(TOKEN_DIR.glob("antigravity-oauth-token*"))
    new_tokens = sorted(token_files_after - token_files_before, key=lambda p: p.stat().st_mtime, reverse=True)
    target = new_tokens[0] if new_tokens else (sorted(token_files_after, key=lambda p: p.stat().st_mtime, reverse=True)[0] if token_files_after else None)
    if not target:
        print(f"NO_TOKEN exit={proc.returncode}", flush=True)
        return 1

    with open(target, encoding="utf-8") as handle:
        token_data = json.load(handle)
    flat = dict(token_data)
    if isinstance(token_data.get("token"), dict):
        flat.update(token_data["token"])
    access_len = len(str(flat.get("access_token") or flat.get("accessToken") or ""))
    refresh_len = len(str(flat.get("refresh_token") or flat.get("refreshToken") or ""))
    if not access_len or not refresh_len:
        print(f"INVALID_TOKEN access_len={access_len} refresh_len={refresh_len}", flush=True)
        return 1

    output_dir = Path("/tmp/ag_tokens")
    output_dir.mkdir(mode=0o700, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", email)
    output = output_dir / f"{safe_name}.json"
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(token_data, handle)
    output.chmod(0o600)
    print(f"TOKEN_SAVED {output} access_len={access_len} refresh_len={refresh_len}", flush=True)
    print("RESULT OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
