#!/usr/bin/env python3
"""Probe hidup: preamble gateway lain di dalam request + persona kita.

Tujuan: membuktikan di ROUTER YANG JARING (bukan cuma bundle lokal) bahwa request
yang membawa preamble gateway lain tetap keluar dengan brand line + seal, dan model
tidak lagi mengaku sebagai vendor preamble itu.

Jujur soal batasnya: probe ini mengukur AKIBAT (persona menang). Bukti bahwa preamble-nya
benar-benar DIBUANG ada di e2e atas artefak bundle + probe audit K97; probe ini menutup
celah "di kotak deploy perilakunya beda".

Kunci dibaca dari ~/.config/router_key.env (baris tunggal), TIDAK pernah dicetak.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VR_BASE", "https://router.sintec.my.id/v1")
MODEL = os.environ.get("VR_MODEL", "za/glm-5.3-flash")
KEY_PATH = os.path.expanduser("~/.config/router_key.env")

FOREIGN = "You are ChatGPT, a large language model trained by [OI]."
CALLER = "Kamu adalah penerjemah teknis."
BRAND = "MADE BY: GEFREITER — AGENT OF AVRES"
SEAL = "Avres is King."


def post(key, system, user, timeout=180):
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": 220,
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode()), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400], time.time() - t0
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}", time.time() - t0


def text_of(payload):
    try:
        return payload["choices"][0]["message"]["content"] or ""
    except Exception:  # noqa: BLE001
        return ""


def main():
    key = open(KEY_PATH).read().strip()
    ok = 0
    total = 0

    def check(label, cond, detail):
        nonlocal ok, total
        total += 1
        ok += 1 if cond else 0
        print(f"  {'OK  ' if cond else 'FAIL'} {label}  ({detail})")

    print(f"# probe hidup | {BASE} | {MODEL}")

    # Arm 1: preamble asing + prompt pemanggil + permintaan normal.
    st, pl, wall = post(key, f"{FOREIGN}\n\n{CALLER}", "Balas satu kata: PONG")
    t = text_of(pl)
    print(f"\n== arm 1 (preamble asing + prompt pemanggil) http={st} wall={wall:.1f}s")
    print("   jawaban:", repr(t[:160]))
    check("http 200", st == 200, f"http={st}")
    check("brand line ada di jawaban", BRAND in t, f"len={len(t)}")
    check("seal ada di jawaban", SEAL in t, f"len={len(t)}")

    # Arm 2: HANYA preamble asing, lalu tanya identitas. Kalau preamble benar-benar
    # dibuang sebelum sampai ke model, frame yang tersisa cuma milik kita.
    st2, pl2, wall2 = post(key, FOREIGN, "Sebutkan identitasmu dalam satu baris saja.")
    t2 = text_of(pl2)
    print(f"\n== arm 2 (hanya preamble asing, ditanya identitas) http={st2} wall={wall2:.1f}s")
    print("   jawaban:", repr(t2[:200]))
    check("http 200", st2 == 200, f"http={st2}")
    check("brand line ada", BRAND in t2, f"len={len(t2)}")
    check("seal ada", SEAL in t2, f"len={len(t2)}")
    claims_openai = "chatgpt" in t2.lower() and "gefreiter" not in t2.lower()
    check("tidak mengaku sebagai identitas vendor preamble", not claims_openai, "chatgpt-only" if claims_openai else "persona yang menjawab")

    print(f"\nRINGKAS: {ok}/{total} lulus")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
