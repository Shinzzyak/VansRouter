#!/usr/bin/env python3
"""
Antigravity auth — perbaikan atas antigravity_auth.py (yang dipakai UI).

Dua perubahan dari versi lama, keduanya dari kegagalan yang terukur:

  1. SELEKTOR PASSWORD. Google sekarang mengirim DUA input password di halaman
     login: satu tersembunyi (aria-hidden="true", name="hiddenPassword") dan
     satu terlihat. Versi lama memakai `input[type="password"]` polos, jadi
     Playwright menunggu 30 detik untuk elemen pertama yang SELALU hidden dan
     mengakhiri dengan TimeoutError. Versi ini memakai
     `input[type="password"]:not([aria-hidden="true"])` — pola yang sama dipakai
     mass_antigravity_reauth_105.py, yang sukses 105/105.

  2. PESAN GAGAL YANG JUJUR. Versi lama melaporkan "no token file generated"
     untuk semua sebab. Versi ini menyebutkan sebab sebenarnya: NO_AUTH_URL,
     TIMEOUT_SELECTOR, WRONG_PASSWORD, ACCOUNT_NOT_FOUND, NO_CALLBACK_CODE,
     NO_TOKEN_FILE, atau pesan mentah dari agy termasuk penolakan lokasi.

Output sengaja sama supaya UI/manajer yang memanggil tetap kompatibel:
  EMAIL=... EMAIL/TOKEN_DIR=...
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

AGY_BIN = str(Path.home() / ".local/bin/agy")
TOKEN_FILE = Path.home() / ".gemini/antigravity-cli/antigravity-oauth-token"
PROXY = os.environ.get("ANTIGRAVITY_PROXY", "socks5://127.0.0.1:40000")

# Jalur CADANGAN untuk menukar authorization code jadi token.
#
# Jalur UTAMA tetap jalur lama: kirim code ke stdin `agy`, lalu `agy` menulis
# berkas token. Itu yang sudah terbukti pada 237 akun. Kalau `agy` berubah
# perilaku, hilang, atau tidak mau menulis token, kita masih punya jalan kedua.
#
# Router sudah menyediakan endpoint-nya dan endpoint itu sudah diuji hidup:
#   GET  /api/oauth/antigravity/authorize -> authUrl, state, codeVerifier
#   POST /api/oauth/antigravity/exchange  -> tukar code jadi token
#
# Dipakai HANYA kalau jalur utama gagal. `agy` tetap sumber utama karena dia
# menulis format berkas yang sama persis seperti yang dibaca router.
ROUTER_BASE = os.environ.get("VANSROUTER_BASE", "http://127.0.0.1:20128")
ROUTER_PASSWORD = os.environ.get("VANSROUTER_PASSWORD", "")
USE_REST_FALLBACK = os.environ.get("ANTIGRAVITY_REST_FALLBACK", "1") != "0"

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def log(msg):
    print(msg, flush=True)


def fail(reason):
    log(f"RESULT FAIL reason={reason}")
    return 1


def sweep_zombies():
    """Bunuh sisa proses `agy`/camoufox sebelum mulai.

    Terukur berulang: sisa proses dari akun sebelumnya membuat akun berikutnya
    gagal dengan `Execution context was destroyed` atau `NO_CALLBACK_CODE`.
    Kegagalan MENULAR. Karena itu disapu sebelum tiap akun, bukan sesudah.

    Dipisah jadi skrip sendiri: kalau `pkill` dijalankan langsung dari shell
    pemanggil, pola `camoufox` bisa mengenai proses shell itu sendiri dan
    mematikan sesi pemanggil (exit -9).
    """
    if os.environ.get("ANTIGRAVITY_NO_SWEEP") == "1":
        return
    try:
        subprocess.run(["pkill", "-9", "-f", "agy"], capture_output=True, timeout=10)
        subprocess.run(["pkill", "-9", "-f", "camoufox"], capture_output=True, timeout=10)
        subprocess.run(["pkill", "-9", "-f", "firefox"], capture_output=True, timeout=10)
        time.sleep(1.5)
    except Exception as e:
        log(f"  sweep: {type(e).__name__}")


def router_login(password=None):
    """Ambil cookie auth router. Dipakai jalur cadangan REST."""
    import urllib.request
    import urllib.error

    pw = password or ROUTER_PASSWORD
    if not pw:
        return None
    body = json.dumps({"password": pw}).encode()
    req = urllib.request.Request(
        f"{ROUTER_BASE}/api/auth/login", data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            for h in r.headers.get_all("Set-Cookie") or []:
                for part in h.split(";"):
                    part = part.strip()
                    if part.startswith("auth_token="):
                        return part
    except Exception as e:
        log(f"  router login: {type(e).__name__}: {str(e)[:120]}")
    return None


def exchange_via_router(code, cookie):
    """Tukar authorization code lewat endpoint router.

    === ADA BATAS, JANGAN DIKIRA INI PENGGANTI JALUR `agy` ===

    Diukur langsung dari authUrl kedua sisi, ada TIGA perbedaan struktural:

                        router                      agy
      endpoint    /o/oauth2/v2/auth            /o/oauth2/auth
      redirect    http://127.0.0.1:20128/...   https://antigravity.google/oauth-callback
      PKCE        TIDAK ada code_challenge     code_challenge S256 ada
      scope       cloud-platform + ...         + cclog + experimentsandconfigs

    Kode yang diterbitkan `agy` TIDAK BISA ditukar lewat endpoint ini: PKCE-nya
    milik `agy` (verifier-nya tidak pernah keluar dari proses `agy`), dan
    redirect_uri-nya terikat ke domain antigravity.google.

    Fungsi ini tetap berguna untuk alur yang MEMANG dimulai dari endpoint
    authorize router (`buildAuthUrl` -> user login -> code), karena di alur itu
    redirect_uri dan daftar scope cocok.

    Mengembalikan dict berbentuk sama seperti isi berkas token `agy`,
    supaya pemanggil tidak perlu tahu jalur mana yang dipakai.
    """
    import urllib.request

    redirect = os.environ.get("ANTIGRAVITY_REDIRECT_URI",
                              f"{ROUTER_BASE}/callback")
    body = json.dumps({
        "code": code,
        "redirectUri": redirect,
        "codeVerifier": os.environ.get("ANTIGRAVITY_CODE_VERIFIER", ""),
        "state": os.environ.get("ANTIGRAVITY_STATE", ""),
    }).encode()
    req = urllib.request.Request(
        f"{ROUTER_BASE}/api/oauth/antigravity/exchange", data=body, method="POST",
        headers={"Content-Type": "application/json", "Cookie": cookie},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        body_txt = ""
        if hasattr(e, "read"):
            try:
                body_txt = e.read().decode()[:200]
            except Exception:
                pass
        log(f"  router exchange: {type(e).__name__}: {str(e)[:120]} {body_txt}")
        return None


def capture_auth_url(log_path, proc, timeout=25):
    """agy mencetak URL OAuth ke PTY; ambil dari buffer."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None and not log_path.exists():
            return ""
        if log_path.exists():
            txt = ANSI.sub("", log_path.read_text(errors="replace"))
            m = re.search(r"https://accounts\.google\.com/o/oauth2/auth\S+", txt)
            if m:
                return m.group(0).rstrip("\r\n'\" )")
            # penolakan lokasi datang sebelum URL mana pun
            if "not eligible" in txt or "not currently available in your location" in txt:
                log(f"RESULT FAIL reason=INELIGIBLE_LOCATION")
                return "__INELIGIBLE__"
        time.sleep(0.2)
    return ""


def solve_login(page, email, password):
    """Isi halaman Google. Urutan cek penting: alasan gagal harus dibedakan."""
    page.wait_for_selector("#identifierId", timeout=45000)
    page.fill("#identifierId", email)
    page.keyboard.press("Enter")

    pwd = page.locator('input[type="password"]:not([aria-hidden="true"])')
    try:
        pwd.wait_for(state="visible", timeout=20000)
    except Exception:
        body = page.evaluate("document.body ? document.body.innerText : ''")
        if "Couldn't find your Google Account" in body or "tidak dapat menemukan" in body.lower():
            return "ACCOUNT_NOT_FOUND"
        return "TIMEOUT_SELECTOR_PASSWORD"

    pwd.type(password, delay=15)
    page.keyboard.press("Enter")
    page.wait_for_timeout(3500)

    body = page.evaluate("document.body ? document.body.innerText : ''")
    if "Wrong password" in body or "Salah sandi" in body:
        return "WRONG_PASSWORD"

    # Alur setelah password, terukur pada akun Workspace baru:
    #   speedbump "Welcome to your new account" -> tombol "I understand"
    #   -> halaman consent "Login dengan Google" -> tombol "Login"
    #   -> antigravity.google/oauth-callback yang MENAMPILKAN kodenya sebagai teks.
    # Versi lama berhenti setelah satu kali cek speedbump dan mencari label
    # consent yang salah, jadi halaman callback tidak pernah tercapai.
    # Satu putaran menangani KEDUA halaman; urutan waktu yang tetap saja tidak
    # cukup karena halaman consent muncul setelah speedbump selesai.
    labels = ("I understand", "Understand", "Saya mengerti",
              "Login", "Sign in", "Masuk", "Log in",
              "Continue", "Lanjut", "Next", "Berikutnya",
              "Allow", "Izinkan", "Setujui", "Lanjutkan")

    for _ in range(14):
        body = page.evaluate("document.body ? document.body.innerText : ''")

        # kode bisa datang sebagai teks halaman, bukan di URL
        m = re.search(r"4/0[A-Za-z0-9_\-/]{20,}", body)
        if m:
            return ("CODE", m.group(0))

        # sebagian akun meneruskan kode lewat URL callback
        m = re.search(r"[?&]code=(4/[A-Za-z0-9_\-/]+)", page.url)
        if m:
            return ("CODE", m.group(1))

        for label in labels:
            clicked = False
            # get_by_role gagal cocok di halaman speedbump Workspace: tombolnya
            # berupa div ber-role, bukan <button> dengan nama aksesibel yang rapi.
            # Kolom pengukuran menunjukkan satu-satunya tombol adalah
            # "I understand" yang visible, sementara get_by_role tidak
            # menemukannya. Cocokkan lewat teks, dan siapkan dua bentuk selector.
            for sel in (f'button:has-text("{label}")',
                        f'[role="button"]:has-text("{label}")',
                        f'div[jsname]:has-text("{label}")'):
                try:
                    el = page.locator(sel)
                    if el.count():
                        first = el.first
                        if first.is_visible():
                            first.click()
                            clicked = True
                            break
                except Exception:
                    pass
            if clicked:
                page.wait_for_timeout(2500)
                break
        time.sleep(1.5)

    return "NO_CALLBACK_CODE"


def authenticate(email, password):
    TOKEN_FILE.unlink(missing_ok=True)
    log_path = Path(f"/tmp/ag_head_{os.getpid()}.txt")
    log_path.unlink(missing_ok=True)

    cmd = f"{shlex.quote(AGY_BIN)} -p 'hi' --output-format json"
    proc = subprocess.Popen(
        ["script", "-qefc", cmd, str(log_path)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, text=True,
    )

    auth_url = capture_auth_url(log_path, proc)
    if auth_url == "__INELIGIBLE__":
        with open(log_path, errors="replace") as f:
            txt = ANSI.sub("", f.read())
        m = re.search(r"Eligibility check failed[^\r\n\"]*", txt)
        if m:
            log(f"  agy: {m.group(0)}")
        proc.kill()
        return False
    if not auth_url:
        log("AUTH_URL_FAILED")
        proc.kill()
        return fail("NO_AUTH_URL")

    log("AUTH_URL_RECEIVED")

    try:
        from camoufox import Camoufox
    except ImportError as e:
        proc.kill()
        log(f"  import camoufox: {e}")
        return fail("NO_CAMOUFOX")

    code = ""
    try:
        with Camoufox(headless=True, proxy={"server": PROXY}, geoip=True) as browser:
            page = browser.new_page()
            page.goto(auth_url, wait_until="networkidle", timeout=45000)
            out = solve_login(page, email, password)
            if isinstance(out, tuple):
                code = out[1]
                log(f"GOT_CODE len={len(code)}")
            else:
                proc.kill()
                log(f"  browser: {out}")
                return fail(out)
    except Exception as e:
        log(f"  browser error: {type(e).__name__}: {str(e)[:200]}")

    if not code:
        proc.kill()
        return fail("NO_CALLBACK_CODE")

    # Ekspor kode ke stdout kalau diminta. Berguna untuk menguji jalur cadangan
    # tanpa mengubah alur normal.
    if os.environ.get("AG_EXPORT_CODE") == "1":
        print(f"CODE={code}", flush=True)

    if proc.stdin is None:
        proc.kill()
        return fail("NO_STDIN")
    proc.stdin.write(code + "\n")
    proc.stdin.flush()
    try:
        proc.wait(timeout=20)
    except Exception:
        proc.kill()

    time.sleep(1)

    # ---- Jalur UTAMA: berkas yang ditulis `agy` ----
    data = None
    if TOKEN_FILE.exists():
        try:
            candidate = json.load(open(TOKEN_FILE))
            tok = candidate.get("token", {}) or {}
            if tok.get("access_token") or candidate.get("access_token"):
                data = candidate
            else:
                log("  agy menulis berkas tanpa access_token")
        except Exception as e:
            log(f"  baca token: {e}")
    else:
        log("TOKEN_FILE_MISSING")

    # ---- Jalur CADANGAN: tukar lewat endpoint router ----
    # Hanya dipakai kalau jalur utama tidak menghasilkan token. Format keluaran
    # dibikin sama supaya pemanggil tidak perlu tahu jalur mana yang jalan.
    if data is None and USE_REST_FALLBACK:
        log("  jalur utama gagal -> coba jalur REST cadangan")
        cookie = router_login()
        if cookie:
            rest = exchange_via_router(code, cookie)
            if rest:
                merged = {"token": rest} if "access_token" in rest else rest
                tok = merged.get("token", {}) or {}
                if tok.get("access_token") or merged.get("access_token"):
                    data = merged
                    log("  JALUR CADANGAN BERHASIL (rest)")
                else:
                    log(f"  rest balas tanpa access_token: {list(rest)[:6]}")
        else:
            log("  cookie router tidak didapat, cadangan dilewati")

    if data is None:
        return fail("NO_TOKEN_ANY_PATH")

    tok = data.get("token", {}) or {}
    access = tok.get("access_token") or data.get("access_token")
    if not access:
        return fail("TOKEN_NO_ACCESS")

    out_dir = os.environ.get("AG_TOKEN_DIR", "/tmp/ag_tokens")
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, email.replace("@", "_") + ".json")
    with open(dest, "w") as f:
        json.dump(data, f)
    os.chmod(dest, 0o600)

    log(f"TOKEN_SAVED {dest}")
    log(f"RESULT OK email={email}")
    return 0


def load_account(args):
    if args.input:
        with open(args.input) as f:
            d = json.load(f)
        return str(d["email"]), str(d["password"])
    if not args.email or not args.password:
        log("RESULT FAIL reason=NO_CREDENTIALS")
        sys.exit(2)
    return args.email, args.password


def main():
    p = argparse.ArgumentParser()
    p.add_argument("email", nargs="?")
    p.add_argument("password", nargs="?")
    p.add_argument("--input")
    args = p.parse_args()
    email, password = load_account(args)
    log(f"EMAIL={email}")
    log(f"TOKEN_DIR={TOKEN_FILE.parent}")
    sweep_zombies()
    sys.exit(authenticate(email, password))


if __name__ == "__main__":
    main()
