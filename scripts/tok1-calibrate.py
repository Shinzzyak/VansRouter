#!/usr/bin/env python3
"""Fit a tokenizer family's four character-class coefficients from live traffic.

The engine ships a seed table (`TOKEN_FAMILIES` in src/tokenProfile.js) with one
entry per model family. Two of them are `measured: true` — gemini and glm — and
the rest are guesses. This script turns a guess into a measurement: it sends a
set of controlled corpora through the router, reads back the provider's own
`prompt_tokens`, and solves

    prompt_tokens = c0 + a*word + b*punct + c*cjk + d*emoji

by least squares. `c0` is the intercept: it absorbs the injected system
contract, the message wrapper and anything else that is byte-identical across
the probes, so the four coefficients describe the corpus alone.

Usage:
    python3 scripts/tok1-calibrate.py --model ag/gemini-3.8-flash-low
    python3 scripts/tok1-calibrate.py --model <id> --expect gemini

`--expect` prints the seed values next to the fit, so a run against a family
already marked measured doubles as a test of this script: if it cannot recover
gemini's published coefficients, its numbers for a new family mean nothing.
"""
import argparse
import json
import sys
import urllib.request

CORPORA = {
    # name: (text, what it is for)
    "ascii_words": ("the router counts characters before it counts tokens and the "
                    "difference between those two numbers is the whole problem " * 4),
    "ascii_punct": ("a,b;c:d!e?f(g)h[i]{j}<k>l|m\\n/o*p+q-r_s=t%u^v&w$#x@y~z " * 6),
    "code": ("function f(a,b){if(a>b){return{a:a,b:b};}else{return null;}}\n"
             "const x=[1,2,3].map(v=>v*2).filter(v=>v>2);\n" * 6),
    "cjk": ("模型路由器令牌估算这是中文测试文本用来测量分词器在每个字符类上的系数" * 8),
    "cjk_short": ("令牌估算测试文本" * 20),
    "emoji": ("🔥🚀🎯🧠⚡🌊🎨🍕🛠️📦" * 12),
    "emoji_mixed": ("ok 🔥 done 🚀 next 🎯 " * 20),
    "indonesian": ("router ini menghitung token per keluarga model jadi angka di "
                   "dashboard tidak lagi meleset untuk teks indonesia " * 4),
    "mixed_all": ("hello 世界 🔥 token 123, ok! " * 15),
    "numbers": ("1 22 333 4444 55555 666666 7777777 88888888 " * 8),
    "ascii_long": ("The quick brown fox jumps over the lazy dog and then keeps "
                   "running because the sentence has to be long enough to matter. " * 8),
    "cjk_long": ("这是一段很长的中文文本用来测试分词器在不同长度下的稳定性以及字符类别的分布情况" * 6),
}


def classify(text):
    """Same four classes the engine counts. Kept in sync by the test below."""
    out = {"chars": 0, "word": 0, "punct": 0, "cjk": 0, "emoji": 0}
    for ch in text:
        cp = ord(ch)
        out["chars"] += 1
        if 0x1F000 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF or cp in (0xFE0F, 0x200D):
            out["emoji"] += 1
        elif (0x4E00 <= cp <= 0x9FFF or 0x3040 <= cp <= 0x30FF
              or 0xAC00 <= cp <= 0xD7AF or 0x3400 <= cp <= 0x4DBF):
            out["cjk"] += 1
        elif ch.isalnum() or ch == " ":
            out["word"] += 1
        else:
            out["punct"] += 1
    return out


def ask(url, api_key, model, text, extra_headers=None, timeout=120):
    body = json.dumps({
        "model": model,
        "stream": False,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": text}],
    }).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    for raw in extra_headers or []:
        name, _, value = raw.partition(":")
        headers[name.strip()] = value.strip()
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    usage = data.get("usage") or {}
    tokens = usage.get("prompt_tokens")
    if not isinstance(tokens, int) or tokens <= 0:
        raise RuntimeError("no prompt_tokens in usage: %r" % (usage,))
    return tokens


SEED = {
    "gemini": {"word": 0.1616, "punct": 1.109, "cjk": 0.5438, "emoji": 1.0671},
    "glm": {"word": 0.2029, "punct": 0.4825, "cjk": 0.5415, "emoji": 1.6442},
}


def fit(rows):
    import numpy as np

    X = np.array([[1.0, r["word"], r["punct"], r["cjk"], r["emoji"]] for r in rows])
    y = np.array([float(r["tokens"]) for r in rows])
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    pred = X @ coef
    resid = y - pred
    rmse = float(np.sqrt((resid ** 2).mean()))
    # Rank tells us whether the corpora actually separated the four classes. A
    # rank-deficient design produces confident garbage.
    rank = int(np.linalg.matrix_rank(X))
    return coef, rmse, rank, pred


def self_test():
    """Fit synthetic rows built from known coefficients. Proves the solver, not
    the data: if this fails, every real run is garbage regardless of provider."""
    import numpy as np

    truth = {"intercept": 3758.0, "word": 0.1616, "punct": 1.109, "cjk": 0.5438, "emoji": 1.0671}
    rng = np.random.default_rng(7)
    rows = []
    for _ in range(24):
        word = int(rng.integers(0, 900))
        punct = int(rng.integers(0, 300))
        cjk = int(rng.integers(0, 300))
        emoji = int(rng.integers(0, 150))
        tokens = (truth["intercept"] + truth["word"] * word + truth["punct"] * punct
                  + truth["cjk"] * cjk + truth["emoji"] * emoji)
        rows.append({"word": word, "punct": punct, "cjk": cjk, "emoji": emoji,
                     "tokens": round(tokens)})
    coef, rmse, rank, _ = fit(rows)
    got = {"intercept": coef[0], "word": coef[1], "punct": coef[2], "cjk": coef[3], "emoji": coef[4]}
    ok = True
    for key, want in truth.items():
        delta = abs(got[key] - want) / max(abs(want), 1e-9)
        mark = "ok" if delta < 0.02 else "FAIL"
        if mark == "FAIL":
            ok = False
        print("  %-9s want %10.4f  got %10.4f  %5.2f%%  %s" % (key, want, got[key], delta * 100, mark))
    print("  rank %d/5, rmse %.2f" % (rank, rmse))
    print("SELF-TEST %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="")
    ap.add_argument("--url", default="http://127.0.0.1:20128/v1/chat/completions")
    ap.add_argument("--key", default="", help="router key, if the route requires one")
    ap.add_argument("--expect", default="", help="seed family to compare against")
    ap.add_argument("--json", default="", help="write raw rows here")
    ap.add_argument("--header", action="append", default=[],
                    help="extra request header, repeatable (e.g. 'x-9router-token-saver: off')")
    ap.add_argument("--self-test", action="store_true", help="verify the solver on synthetic rows")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not args.model:
        ap.error("--model is required unless --self-test")

    rows = []
    for name, text in CORPORA.items():
        counts = classify(text)
        try:
            tokens = ask(args.url, args.key, args.model, text, args.header)
        except Exception as exc:  # noqa: BLE001 — one dead corpus must not kill the fit
            print("SKIP %-14s %s" % (name, str(exc)[:90]))
            continue
        rows.append({"corpus": name, "tokens": tokens, **counts})
        print("OK   %-14s chars=%-5d tokens=%-6d %s" % (name, counts["chars"], tokens,
                                                        {k: v for k, v in counts.items() if k != "chars"}))

    if len(rows) < 6:
        print("\nNOT ENOUGH ROWS (%d). A fit on this many corpora is noise." % len(rows))
        return 2

    coef, rmse, rank, pred = fit(rows)
    c0, a, b, c, d = coef
    print("\nintercept   %.1f  (the injected contract, absorbed)" % c0)
    print("word        %.4f" % a)
    print("punct       %.4f" % b)
    print("cjk         %.4f" % c)
    print("emoji       %.4f" % d)
    print("rmse        %.2f tokens over %d corpora" % (rmse, len(rows)))
    print("design rank %d/5%s" % (rank, "" if rank == 5 else "  ← DEGENERATE, corpora do not separate the classes"))

    if args.expect and args.expect in SEED:
        seed = SEED[args.expect]
        print("\nseed %s vs fit:" % args.expect)
        for key, val in (("word", a), ("punct", b), ("cjk", c), ("emoji", d)):
            want = seed[key]
            print("  %-6s seed %.4f  fit %.4f  %+.1f%%" % (key, want, val, (val / want - 1) * 100))

    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"model": args.model, "rows": rows,
                       "coef": {"intercept": c0, "word": a, "punct": b, "cjk": c, "emoji": d},
                       "rmse": rmse, "rank": rank}, fh, indent=2)
        print("\nwrote %s" % args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
