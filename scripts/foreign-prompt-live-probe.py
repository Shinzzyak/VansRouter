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
import re
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VR_BASE", "https://router.sintec.my.id/v1")
MODEL = os.environ.get("VR_MODEL", "za/glm-5.3-flash")
KEY_PATH = os.path.expanduser("~/.config/router_key.env")

FOREIGN = "You are ChatGPT, a large language model trained by [OI]."
CALLER = "Kamu adalah penerjemah teknis."
# K98: what a Kiro-fronted gateway glues to the first user turn, and what it must not
# leave behind in the reply.
KIRO_PREAMBLE = "You are Kiro, an AI agent that helps with software engineering tasks."

# K99: lab names the identity answer must never carry. Same list as the engine gate
# (tests/selfDescriptionClause.test.mjs) — effect-only wording in the clause, names here.
LAB_PATTERNS = [
    ("zai", re.compile(r"\bz\.?ai\b|\bzhipu\b", re.I)),
    ("openai", re.compile(r"\bopenai\b|\bchatgpt\b", re.I)),
    ("anthropic", re.compile(r"\banthropic\b|\bclaude\b", re.I)),
    ("google", re.compile(r"\bgoogle\b|\bdeepmind\b|\bgemini\b", re.I)),
    ("alibaba", re.compile(r"\balibaba\b|\bqwen\b|\btongyi\b", re.I)),
    ("tencent", re.compile(r"\btencent\b|\bcodebuddy\b", re.I)),
    ("moonshot", re.compile(r"\bmoonshot\b|\bkimi\b", re.I)),
    ("deepseek", re.compile(r"\bdeepseek\b", re.I)),
    ("xai", re.compile(r"\bxai\b|\bx\.ai\b|\bgrok\b", re.I)),
    ("meta", re.compile(r"\bmeta\b|\bllama\b", re.I)),
    ("mistral", re.compile(r"\bmistral\b", re.I)),
]
BRAND = "MADE BY: GEFREITER — AGENT OF AVRES"
SEAL = "Avres is King."


def _post_once(key, system, user, timeout=180):
    """system=None omits the system message entirely — that is the K98 container."""
    messages = [] if system is None else [{"role": "system", "content": system}]
    messages.append({"role": "user", "content": user})
    body = json.dumps({"model": MODEL, "messages": messages, "max_tokens": 220}).encode()
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


def post(key, system, user, timeout=180):
    """post(), retried ONCE on a transport stall (http=0).

    Measured 2026-10-13: a full run reported 7 FAILs whose answers were all empty and
    whose walls were all exactly the 180s timeout, while the same arm answered clean on
    a retry seconds later. A read timeout is the provider stalling, not a behavioural
    failure — reporting the pipe as a verdict is the K29 mistake in a new costume, and
    it hides real regressions behind noise. Genuine HTTP errors (4xx/5xx) are NOT
    retried: those are answers.
    """
    st, payload, wall = _post_once(key, system, user, timeout)
    if st == 0:
        st, payload, wall = _post_once(key, system, user, timeout)
    return st, payload, wall


def labs_in(t):
    """Lab names present in an answer. Arm 4 was the ONLY arm checking this, so a leak that
    only shows up on the foreign-preamble arms (measured 2026-10-13: arm 2 answered
    "…at the core still GLM, AI model from Z.ai.") reported 16/16 lulus while naming the lab.
    Every arm's answer goes through this now."""
    return [lab for lab, re_ in LAB_PATTERNS if re_.search(t)]


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
    named1 = labs_in(t)
    check("tidak menyebut lab upstream", not named1, ",".join(named1) if named1 else "bersih")

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
    named2 = labs_in(t2)
    check("tidak menyebut lab upstream", not named2, ",".join(named2) if named2 else "bersih")

    # Arm 3 (K98): container TANPA system role. Preamble harness + pertanyaan pemanggil
    # nempel di satu string di turn user. Dua hal yang diukur: pertanyaan pemanggil
    # SELAMAT (kalau sweep-nya salah potong, PONG tidak akan muncul), dan persona kita
    # yang menjawab — bukan agent prompt harness-nya.
    kiro_content = f"{KIRO_PREAMBLE}\n\nBalas satu kata: PONG"
    st3, pl3, wall3 = post(key, None, kiro_content)
    t3 = text_of(pl3)
    print(f"\n== arm 3 (tanpa system role: preamble harness di turn user) http={st3} wall={wall3:.1f}s")
    print("   jawaban:", repr(t3[:200]))
    check("http 200", st3 == 200, f"http={st3}")
    check("brand line ada", BRAND in t3, f"len={len(t3)}")
    check("seal ada", SEAL in t3, f"len={len(t3)}")
    check("pertanyaan pemanggil SELAMAT (PONG)", "PONG" in t3.upper(), repr(t3[:80]))
    claims_kiro = "kiro" in t3.lower() and "gefreiter" not in t3.lower()
    check("tidak mengaku sebagai agent harness preamble", not claims_kiro, "kiro-voice" if claims_kiro else "persona yang menjawab")
    named3 = labs_in(t3)
    check("tidak menyebut lab upstream", not named3, ",".join(named3) if named3 else "bersih")

    # Arm 4 (K99): ditanya identitas, jawabannya tidak boleh menyebut lab upstream-nya.
    # Ini guard tingkat-prompt, jadi ini MENGUKUR EFEK — kalau merah, klausanya kurang
    # gigi, bukan berarti gerbangnya mati.
    st4, pl4, wall4 = post(key, "Be terse.", "Kamu model apa? Jawab satu baris saja.")
    t4 = text_of(pl4)
    print(f"\n== arm 4 (ditanya identitas: nama lab) http={st4} wall={wall4:.1f}s")
    print("   jawaban:", repr(t4[:200]))
    check("http 200", st4 == 200, f"http={st4}")
    check("brand line ada", BRAND in t4, f"len={len(t4)}")
    check("seal ada", SEAL in t4, f"len={len(t4)}")
    named = labs_in(t4)
    check("tidak menyebut lab upstream", not named, ",".join(named) if named else "bersih")

    print(f"\nRINGKAS: {ok}/{total} lulus")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
