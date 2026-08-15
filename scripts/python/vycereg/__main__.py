"""vycereg — Vyce AI bulk register + referral chain.

Flow per akun (pure HTTP, no browser):
1. GET /user/csrf → csrfToken
2. GET /user/pow → {id, prefix, difficulty} — solve SHA-256 PoW
3. POST /user/pow... solve turnstile via local solver :8877
4. POST /user/register {email, password, name, captchaToken, csrfToken, powId, powNonce, referralCode, fingerprint, fpVersion}
5. POST /user/keys → API key
6. Accept referral ToS (/user/referral/accept-tos) + report referral code

Referral chain: setiap akun N pakai referralCode akun N-1 → chain 40% starting credit.
"""
import argparse, hashlib, json, os, random, re, sys, time
import urllib.request, urllib.error

BASE = "https://vyceai.com"
SITEKEY = "0x4AAAAAAD5F6BfSHmTDWS4a"
SOLVER = "http://127.0.0.1:8877/solve"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

NAMES = ["Aiden", "Bima", "Cakra", "Dimas", "Eka", "Farhan", "Gilang", "Hadi",
         "Indra", "Joko", "Kai", "Lukas", "Made", "Nando", "Oscar", "Putra",
         "Raka", "Surya", "Teguh", "Umar", "Vino", "Wira", "Yoga", "Zaki"]

def _req(path, data=None, headers=None, method=None, timeout=25):
    url = BASE + path
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers: h.update(headers)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=h, method=method or ("POST" if data is not None else "GET"))
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": {"message": "raw"}}
    except Exception as e:
        return 0, {"error": {"message": str(e)[:120]}}

def _lbits(hexstr):
    bits = 0
    for c in hexstr:
        v = int(c, 16)
        if v == 0:
            bits += 4
        else:
            bits += 4 - v.bit_length()
            break
    return bits

def _solve_pow(prefix, difficulty):
    r = 0
    while True:
        if _lbits(hashlib.sha256((prefix + str(r)).encode()).hexdigest()) >= difficulty:
            return r
        r += 1

def _solve_turnstile(timeout_s=90):
    req_s = urllib.request.Request(SOLVER,
        data=json.dumps({"type": "turnstile", "url": BASE + "/signup", "sitekey": SITEKEY, "timeout_s": timeout_s}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    sol = json.loads(urllib.request.urlopen(req_s, timeout=timeout_s + 25).read())
    if not sol.get("solved"):
        raise RuntimeError("turnstile solve failed: " + str(sol)[:120])
    return sol["token"]

def register_one(email, password, name, referral_code=None, out=None):
    st, csrf_d = _req("/user/csrf")
    if st != 200:
        return {"status": "failed", "error": f"csrf {st}"}
    csrf = csrf_d.get("token", "")
    st, pw_d = _req("/user/pow")
    if st != 200:
        return {"status": "failed", "error": f"pow {st}"}
    t0 = time.time()
    nonce = _solve_pow(pw_d["prefix"], pw_d["difficulty"])
    pow_time = time.time() - t0
    captcha = _solve_turnstile()
    body = {
        "email": email, "password": password, "name": name,
        "captchaToken": captcha, "csrfToken": csrf,
        "powId": pw_d["id"], "powNonce": str(nonce),
        "fingerprint": "fp-" + hashlib.md5(email.encode()).hexdigest()[:16],
        "fpVersion": "1",
    }
    if referral_code:
        body["referralCode"] = referral_code
    st, reg_d = _req("/user/register", body, timeout=30)
    if st not in (200, 201):
        msg = (reg_d.get("error") or {}).get("message", "") or json.dumps(reg_d)[:120]
        return {"status": "failed", "error": msg, "http": st}
    user = reg_d.get("user", {})
    token = reg_d.get("token", "")
    if isinstance(token, dict):
        token = token.get("accessToken") or token.get("token") or ""
    token = str(token)
    # create API key
    st, key_d = _req("/user/keys", {"name": f"vk-{int(time.time())}"},
                     {"Authorization": "Bearer " + token}, "POST")
    api_key = ""
    if st in (200, 201):
        api_key = key_d.get("key", "") if isinstance(key_d, dict) else ""
    # accept referral ToS
    try:
        _req("/user/referral/accept-tos", {}, {"Authorization": "Bearer " + token}, "POST")
    except Exception:
        pass
    res = {
        "status": "ok", "email": email, "password": password,
        "api_key": api_key, "balance": user.get("totalBalance"),
        "referral_code": user.get("referralCode", ""),
        "referred_by": user.get("referredBy"),
        "user_id": user.get("id"),
        "pow_time": round(pow_time, 1),
    }
    if out is not None:
        out.append(res)
    return res

def main():
    ap = argparse.ArgumentParser(description="Vyce AI bulk register + referral chain")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--domain", default="atherberg.biz.id")
    ap.add_argument("--prefix", default="vyce")
    ap.add_argument("--seed-reff", default="", help="referral code seed (chain head)")
    ap.add_argument("--password", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()

    results = []
    cur_reff = args.seed_reff or None
    password = args.password or ("Vc" + hashlib.md5(os.urandom(8)).hexdigest()[:10] + "!")
    for i in range(args.count):
        ts = int(time.time() * 1000) % 100000000
        email = f"{args.prefix}{ts}{i}@{args.domain}"
        name = random.choice(NAMES) + str(random.randint(10, 99))
        r = register_one(email, password, name, cur_reff, results)
        line = json.dumps(r)
        print(line, flush=True)
        if r["status"] == "ok":
            cur_reff = r["referral_code"] or cur_reff
        time.sleep(args.sleep)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(results, f, indent=1)
        print(f"[vyce] saved {len(results)} to {args.out}")

if __name__ == "__main__":
    main()
