#!/usr/bin/env python3
"""E2E for the admin-only API-key resale surface (live router).

Proves, against the running router, the two defects this work fixed:
  A. a key minted with an allow-list comes out restricted (no second PUT)
  B. the key holder can read its own policy, expiry and usage

and that the policy actually bites: a model outside the allow-list and a
kind outside the allow-list are refused, an expired key is dead.

Reads machine-id/cli-secret to mint the admin token. Never prints either.
"""
import datetime
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VR_BASE", "http://127.0.0.1:20128")
REPO = os.environ.get("VR_REPO", "/home/ubuntu/VansRouter")
DB = os.path.join(REPO, "data", "db", "data.sqlite")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" :: {detail}" if detail else ""), flush=True)
    return ok


def token():
    mid = open(os.path.join(REPO, "data", "machine-id")).read().strip()
    sec = open(os.path.join(REPO, "data", "auth", "cli-secret")).read().strip()
    return hashlib.sha256((mid + "9r-cli-auth" + sec).encode()).hexdigest()[:16]


TOK = token()


def req(path, method="GET", body=None, headers=None, timeout=120):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=timeout) as resp:
            return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}", {}


def admin(path, method="GET", body=None):
    return req(path, method, body, {"x-9r-cli-token": TOK})


def mask(k):
    return k[:6] + "..." + k[-4:] if k and len(k) > 12 else "<key>"


def raw_row(key_id):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM apiKeys WHERE id=?", (key_id,)).fetchone()
    has_tbl = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeyModelAccess'").fetchone()
    models = [r[0] for r in con.execute(
        "SELECT model FROM apiKeyModelAccess WHERE apiKeyId=?", (key_id,)).fetchall()] if has_tbl else None
    con.close()
    return dict(row) if row else None, models


def raw_code(code):
    """Read a redeemCodes row straight from the DB, bypassing the API."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT * FROM redeemCodes WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None
    except sqlite3.Error as e:
        return {"_error": str(e)}
    finally:
        con.close()


def schema_probe():
    """Which wave-2 pieces the live DB actually has."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        cols = [r[1] for r in con.execute("PRAGMA table_info(apiKeys)").fetchall()]
        tbl = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='redeemCodes'").fetchone()
        return cols, bool(tbl)
    finally:
        con.close()


def main():
    stamp = time.strftime("%H%M%S")
    print(f"base={BASE} repo={REPO} run={stamp}", flush=True)

    # ---- A. mint with the whole policy in one POST -------------------------
    past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)).isoformat()
    future = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat()
    allow_model = "combo/round"
    # A real, currently-listed model that is NOT in the allowlist - a bogus id
    # would be rejected as "not available" and prove nothing about the ACL.
    st, txt, _ = req("/v1/models")
    listed = [m["id"] for m in json.loads(txt).get("data", [])] if st == 200 else []
    other_model = None
    for cand in listed:
        if cand.startswith("combo/") or "/" not in cand or cand.endswith("/"):
            continue
        sti, _, _ = req("/api/models/info?id=" + urllib.parse.quote(cand, safe=""))
        if sti == 200:
            other_model = cand
            break
    if not other_model:
        other_model = "nar/deepseek-v4-flash"
    check("P0 found a resolvable model outside the allowlist", bool(other_model), f"picked={other_model}")

    body = {
        "name": f"zz-resale-e2e-{stamp}",
        "limits": {"rpm": 5, "rpd": 20, "maxTokens": 4096, "expiresAt": future},
        "allowedProviders": ["nar"],
        "allowedCombos": ["round"],
        "allowedKinds": ["llm"],
        "allowedModels": [allow_model],
        "personaInject": "e2e-probe",
    }
    st, txt, _ = admin("/api/keys", "POST", body)
    check("A1 create with policy -> 201", st == 201, f"http {st}")
    if st != 201:
        print(txt[:400])
        return 1
    created = json.loads(txt)
    key = created["key"]
    kid = created["id"]
    check("A2 create echoes ACL in response",
          created.get("allowedProviders") == ["nar"] and created.get("allowedKinds") == ["llm"]
          and created.get("allowedModels") == [allow_model],
          f"prov={created.get('allowedProviders')} kinds={created.get('allowedKinds')} "
          f"models={created.get('allowedModels')} persona={created.get('personaInject')}")
    check("A3 create echoes limits", created.get("limits", {}).get("rpm") == 5,
          json.dumps(created.get("limits")))

    # raw row: the columns used to be hardcoded NULL here
    row, models = raw_row(kid)
    if row:
        check("A4 raw row ACL columns non-NULL",
              row.get("allowedProviders") not in (None, "") and row.get("allowedKinds") not in (None, ""),
              f"prov={row.get('allowedProviders')!r} combos={row.get('allowedCombos')!r} kinds={row.get('allowedKinds')!r}")
        check("A5 raw row per-model allowlist written",
              models == [allow_model], f"rows={models}")
        check("A6 raw row expiry stored",
              bool(row.get("expiresAt")), f"expiresAt={row.get('expiresAt')!r}")
    else:
        check("A4 raw row present", False, "apiKeys row missing")

    # GET /api/keys/<id> (admin) must show the same thing without a PUT
    st, txt, _ = admin(f"/api/keys/{kid}")
    if st == 200:
        k = json.loads(txt).get("key", {})
        check("A7 admin GET shows ACL without a PUT",
              k.get("allowedProviders") == ["nar"] and k.get("allowedKinds") == ["llm"],
              f"prov={k.get('allowedProviders')} kinds={k.get('allowedKinds')}")
    else:
        check("A7 admin GET shows ACL without a PUT", False, f"http {st}")

    # ---- B. the holder reads its own policy -------------------------------
    st, txt, hdr = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {key}"})
    check("B1 GET /api/v1/key -> 200", st == 200, f"http {st}")
    self_view = json.loads(txt) if st == 200 else {}
    if st == 200:
        flat = json.dumps(self_view)
        check("B2 self-serve view carries the policy",
              "nar" in flat and "llm" in flat and allow_model in flat,
              f"keys={sorted(self_view.keys())}")
        check("B3 self-serve view carries expiry", "expiresAt" in flat or "expires" in flat,
              f"expiresAt={self_view.get('expiresAt') or self_view.get('expires', {}).get('expiresAt')}")
        check("B4 self-serve view carries usage",
              any("used" in json.dumps(v) for v in self_view.values() if isinstance(v, dict)),
              f"usage={json.dumps(self_view.get('usage'))[:120]}")
        check("B5 raw secret never echoed", key not in txt,
              "masked=" + str(self_view.get("key") or self_view.get("keyDisplay")))
        check("B6 CORS open for a browser-held key",
              str(hdr.get("Access-Control-Allow-Origin") or hdr.get("access-control-allow-origin") or "") == "*",
              "acao=" + str(hdr.get("Access-Control-Allow-Origin") or hdr.get("access-control-allow-origin")))

    # no key / bogus key
    st0, _, _ = req("/api/v1/key")
    st1, _, _ = req("/api/v1/key", "GET", None, {"Authorization": "Bearer sk-not-a-real-key"})
    check("B7 no key -> 401", st0 == 401, f"http {st0}")
    check("B8 bogus key -> 401", st1 == 401, f"http {st1}")

    # ---- C. the policy bites ---------------------------------------------
    def chat(model, key_str=key, kind_path="/v1/chat/completions", ip=None):
        headers = {"Authorization": f"Bearer {key_str}"}
        # Source address is a request header, so the IP allow-list can only be
        # exercised by claiming one: the router reads x-forwarded-for first.
        if ip:
            headers["x-forwarded-for"] = ip
        return req(kind_path, "POST",
                   {"model": model, "messages": [{"role": "user", "content": "say OK"}],
                    "max_tokens": 16}, headers, timeout=90)

    # The per-key model allowlist (9router-go F-7) is enforced at dispatch, but
    # its refusal is a 404 ("not available") - the same shape as an unknown model
    # - so the control matters: prove the model dispatches anonymously, then prove
    # the restricted key cannot reach the same model.
    ctl_model = "cbai/deepseek-v4.1-flash"
    st_anon, txt_anon, _ = chat(ctl_model, "")
    check("C1a control: model dispatches anonymously", st_anon != 404, f"http {st_anon} :: {txt_anon[:100]}")
    st_r, txt_r, _ = chat(ctl_model)
    check("C1b restricted key refuses the same model", st_r in (403, 404),
          f"http {st_r} :: {txt_r[:140]}")

    # Isolate the *model* allowlist: open provider list, one allowed model only.
    # The provider gate (chat.js:463) fires before the model gate (chat.js:498),
    # so a key with both lists set can only ever show the provider refusal.
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-model-{stamp}",
        "limits": {"rpm": 5},
        "allowedKinds": ["llm"],
        "allowedModels": [ctl_model],
    })
    model_key_id = None
    if st == 201:
        mj = json.loads(txt)
        model_key_id = mj["id"]
        st2, txt2, _ = chat(ctl_model, mj["key"])
        check("C1d allowed model passes the model gate", st2 != 404, f"http {st2} :: {txt2[:100]}")
        st3, txt3, _ = chat("skg/bansos/glm-5.3-flash", mj["key"])
        check("C1e model outside the allowlist refused by the model gate", st3 == 404,
              f"http {st3} :: {txt3[:140]}")
    else:
        check("C1d allowed model passes the model gate", False, f"create http {st}")

    # the listing is filtered by the same allowlist
    st_l, txt_l, _ = req("/v1/models", "GET", None, {"Authorization": f"Bearer {key}"})
    ids_l = [m["id"] for m in json.loads(txt_l).get("data", [])] if st_l == 200 else []
    check("C1c /v1/models filtered to the allowlist", ids_l == [allow_model],
          f"n={len(ids_l)} ids={ids_l[:5]}")

    # Positive path needs a key whose provider list is open: a combo fans out to
    # member providers, so a provider allow-list can veto the combo even when the
    # combo itself is allowed. That is defence in depth, not a bug - but it means
    # a seller who wants "combo X only" must leave allowedProviders unset.
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-combo-{stamp}",
        "limits": {"rpm": 5},
        "allowedCombos": ["round"],
        "allowedKinds": ["llm"],
    })
    combo_id = None
    if st == 201:
        cj = json.loads(txt)
        combo_id = cj["id"]
        check("C2 combo-only key created", cj.get("allowedProviders") is None,
              f"prov={cj.get('allowedProviders')} combos={cj.get('allowedCombos')}")
        st2, txt2, _ = chat(allow_model, cj["key"])
        check("C2b allowed combo not ACL-refused", st2 != 403, f"http {st2} :: {txt2[:120]}")
    else:
        check("C2 combo-only key created", False, f"http {st}")

    # kind gate, exercised where the key is actually resolved: this key may only
    # do images, so an LLM chat must be refused. (/v1/embeddings would prove
    # nothing here - see the requireApiKey note below.)
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-kind-{stamp}",
        "limits": {"rpm": 5},
        "allowedKinds": ["image"],
    })
    kind_id = None
    if st == 201:
        kj = json.loads(txt)
        kind_id = kj["id"]
        st2, txt2, _ = chat(allow_model, kj["key"])
        check("C3 disallowed kind refused", st2 == 403, f"http {st2} :: {txt2[:160]}")
    else:
        check("C3 disallowed kind refused", False, f"create http {st}")

    # ---- D. expiry --------------------------------------------------------
    # Whether an expired key is refused *on the data path* depends on one live
    # setting: with requireApiKey=false a handler that never resolves the key
    # (embeddings, tts, image, ...) treats an expired key as anonymous, and
    # chat.js resolves it for policy but still lets an unresolvable key through.
    # So this asserts the observed truth and names the prerequisite, instead of
    # pretending the gate is unconditional.
    require_key = None
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        require_key = json.loads(con.execute("SELECT data FROM settings WHERE id=1").fetchone()[0]).get("requireApiKey")
        con.close()
    except Exception as e:  # noqa: BLE001
        print(f"  (could not read requireApiKey: {e})")
    print(f"  requireApiKey live = {require_key}", flush=True)

    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-expired-{stamp}",
        "limits": {"rpm": 5, "expiresAt": past},
        "allowedKinds": ["llm"],
    })
    expired_id = None
    if st == 201:
        ej = json.loads(txt)
        expired_id = ej["id"]
        ekey = ej["key"]
        st2, txt2, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {ekey}"})
        check("D1 expired key dead at self-serve reader", st2 in (401, 403), f"http {st2} :: {txt2[:120]}")
        st3, txt3, _ = req("/v1/chat/completions", "POST",
                           {"model": "zz-no-such-model", "messages": [{"role": "user", "content": "hi"}],
                            "max_tokens": 8}, {"Authorization": f"Bearer {ekey}"}, timeout=45)
        if require_key:
            check("D2 expired key refused at chat", st3 in (401, 403), f"http {st3} :: {txt3[:160]}")
        else:
            # A refused key would be 401/403 before model resolution; reaching the
            # model layer proves the expired key was silently treated as anonymous.
            check("D2 requireApiKey=false: expired key degrades to anonymous (documented)",
                  st3 in (400, 404), f"http {st3} :: {txt3[:140]}")
    else:
        check("D0 expired key created", False, f"http {st}")

    # ---- F. limits: the rpm and per-request token caps the seller sets ----
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-rpm-{stamp}",
        "limits": {"rpm": 1},
        "allowedKinds": ["llm"],
    })
    rpm_id = None
    if st == 201:
        rj = json.loads(txt)
        rpm_id = rj["id"]
        st1, txt1, _ = chat(ctl_model, rj["key"])
        st2, txt2, _ = chat(ctl_model, rj["key"])
        check("F1 first request within rpm=1 passes", st1 != 429, f"http {st1}")
        check("F2 second request in the same minute -> 429", st2 == 429, f"http {st2} :: {txt2[:140]}")
    else:
        check("F1 first request within rpm=1 passes", False, f"create http {st}")

    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-maxtok-{stamp}",
        "limits": {"rpm": 5, "maxTokens": 8},
        "allowedKinds": ["llm"],
    })
    tok_id = None
    if st == 201:
        tj = json.loads(txt)
        tok_id = tj["id"]
        st3, txt3, _ = req("/v1/chat/completions", "POST",
                           {"model": ctl_model, "messages": [{"role": "user", "content": "say OK"}],
                            "max_tokens": 64}, {"Authorization": f"Bearer {tj['key']}"}, timeout=60)
        check("F3 max_tokens above the key's cap refused", st3 == 429,
              f"http {st3} :: {txt3[:140]}")
    else:
        check("F3 max_tokens above the key's cap refused", False, f"create http {st}")

    # ---- G. IP allow-list per key (wave 2) --------------------------------
    cols, has_redeem_tbl = schema_probe()
    check("M1 migration 010 live: apiKeys carries the resale columns",
          all(c in cols for c in ("allowedIps", "tokenBalance", "tokensSpent")),
          f"missing={[c for c in ('allowedIps','tokenBalance','tokensSpent') if c not in cols]}")
    check("M2 migration 010 live: redeemCodes table exists", has_redeem_tbl)

    allowed_ip = "203.0.113.7"
    foreign_ip = "198.51.100.4"

    # The address the router attributes this caller to, read from the buyer
    # reader. Discovering it instead of asserting a hardcoded one keeps this
    # section valid both on loopback and against the remote deployment, where the
    # socket-derived address is the only one that counts.
    st_si, txt_si, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {key}"})
    source_ip = json.loads(txt_si).get("sourceIp") if st_si == 200 else None
    check("G0 the reader reports the source address the router uses", bool(source_ip),
          f"http {st_si} sourceIp={source_ip}")

    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-ip-{stamp}",
        "limits": {"rpm": 20},
        "allowedKinds": ["llm"],
        "allowedIps": [source_ip] if source_ip else [allowed_ip],
    })
    ip_id, ip_key = None, None
    open_id = None
    if st == 201:
        ij = json.loads(txt)
        ip_id, ip_key = ij["id"], ij["key"]
        check("G1 create with allowedIps -> 201 and echoed", ij.get("allowedIps") == [source_ip],
              f"echo={ij.get('allowedIps')}")
        row, _ = raw_row(ip_id)
        check("G2 raw row stores the allow-list (not NULL)", bool(row) and row.get("allowedIps") not in (None, ""),
              f"allowedIps={row.get('allowedIps') if row else None}")

        st_ok, txt_ok, _ = chat(ctl_model, ip_key)
        check("G3 bound key works from its own address", st_ok != 403 and st_ok != 401,
              f"http {st_ok} :: {txt_ok[:120]}")

        st_rk, txt_rk, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {ip_key}"})
        check("G4 the reader agrees the bound key may read from here", st_rk == 200,
              f"http {st_rk} :: {txt_rk[:120]}")
    else:
        check("G1 create with allowedIps -> 201 and echoed", False, f"http {st}")

    # Second key, bound to an address that is definitely not this caller.
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-ipbad-{stamp}",
        "limits": {"rpm": 20},
        "allowedKinds": ["llm"],
        "allowedIps": [foreign_ip],
    })
    ipbad_id, ipbad_key = None, None
    if st == 201:
        bj2 = json.loads(txt)
        ipbad_id, ipbad_key = bj2["id"], bj2["key"]
        st_bad, txt_bad, _ = chat(ctl_model, ipbad_key)
        check("G5 bound key refused from another address", st_bad == 403,
              f"http {st_bad} :: {txt_bad[:120]}")
        st_rb, _, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {ipbad_key}"})
        check("G6 the reader also refuses the blocked address", st_rb in (401, 403), f"http {st_rb}")

        # G8: the listing surfaces are not a side door around the binding.
        # Presenting a key must never be a way to shed its address and read the
        # catalogue anyway — this is where it used to leak (found live, fixed in
        # the same wave: the listing routes had no address gate at all).
        for list_path in ("/v1/models", "/v1/models/image", "/api/v1/models"):
            st_l, txt_l, _ = req(list_path, "GET", None, {"Authorization": f"Bearer {ipbad_key}"})
            check(f"G8 {list_path} refuses the blocked address", st_l == 403,
                  f"http {st_l} :: {txt_l[:120]}")
        # No spoof check here: custom-server.js strips every client-supplied
        # forwarding header before the route sees it, and the precedence rule is
        # pinned deterministically in tests/unit/apikey-resale-hardening.test.js.
        # Control: the unbound key is untouched by any of this.
        # Control key, freshly minted with no IP binding and no provider ACL: the
        # main key below carries an allowedProviders list, so its refusal would be
        # the provider gate answering, not the address gate we are testing.
        st_co, txt_co, _ = admin("/api/keys", "POST", {
            "name": f"zz-resale-open-{stamp}", "limits": {"rpm": 20}, "allowedKinds": ["llm"]})
        if st_co == 201:
            open_id = json.loads(txt_co)["id"]
            st_open, txt_open, _ = chat(ctl_model, json.loads(txt_co)["key"])
            check("G7 control: unbound key still works", st_open != 403,
                  f"http {st_open} :: {txt_open[:120]}")
        else:
            check("G7 control: unbound key still works", False, f"create http {st_co}")
    else:
        for name in ("G5 bound key refused from another address",
                     "G6 the reader also refuses the blocked address",
                     "G7 control: unbound key still works",
                     "G8 /v1/models refuses the blocked address",
                     "G8 /v1/models/image refuses the blocked address",
                     "G8 /api/v1/models refuses the blocked address"):
            check(name, False, f"create http {st}")

    # ---- H. the buyer path: a code becomes a key (wave 3) -----------------
    # H1-H4 still watch the prepaid balance gate. From H5 on, the flow is the
    # buyer's: a code is the product, and spending it mints the key it buys.
    st, txt, _ = admin("/api/keys", "POST", {
        "name": f"zz-resale-bal-{stamp}",
        "limits": {"rpm": 20, "tokenBalance": 30},
        "allowedKinds": ["llm"],
    })
    bal_id, bal_key = None, None
    code_ids = []
    if st == 201:
        bj = json.loads(txt)
        bal_id, bal_key = bj["id"], bj["key"]
        check("H1 create with tokenBalance -> 201 and echoed",
              bj.get("limits", {}).get("tokenBalance") == 30, f"echo={bj.get('limits', {}).get('tokenBalance')}")

        st_c1, txt_c1, _ = chat(ctl_model, bal_key)
        check("H2 first request against a fresh balance passes", st_c1 not in (402, 429),
              f"http {st_c1} :: {txt_c1[:120]}")
        time.sleep(1)
        row, _ = raw_row(bal_id)
        spent = (row or {}).get("tokensSpent") or 0
        check("H3 the completed request is debited from the balance", spent > 0, f"tokensSpent={spent}")

        # Admin drops the balance below what was already spent: the gate must shut.
        st_p, _, _ = admin(f"/api/keys/{bal_id}", "PUT", {"limits": {"tokenBalance": 1}})
        st_c2, txt_c2, _ = chat(ctl_model, bal_key)
        # 402, not 429: waiting never clears a spent balance, and a client that
        # backs off on 429 would retry forever against a key only the seller can replace.
        check("H4 balance below spend -> 402 payment required", st_c2 == 402,
              f"put={st_p} http {st_c2} :: {txt_c2[:140]}")
        check("H4b the 402 names the reason", "insufficient_balance" in txt_c2, f"body={txt_c2[:140]}")

        # The seller mints a batch; one code = one sale.
        st_m, txt_m, _ = admin("/api/redeem-codes", "POST", {
            "quantity": 2, "batchName": f"zz-batch-{stamp}", "tokenValue": 100000, "extendsDays": 30,
        })
        codes = json.loads(txt_m).get("codes", []) if st_m == 201 else []
        code_ids = [c["id"] for c in codes]
        check("H5 admin mints a redeem-code batch", st_m == 201 and len(codes) == 2,
              f"http {st_m} count={len(codes)}")
        if codes:
            good = codes[0]["code"]
            check("H6 minted code is well formed", len(good) == 14 and good.count("-") == 2, f"code={good}")

            # H7: the buyer's entire interface — a code, pasted in lower case, no key,
            # no account, no session.
            st_r, txt_r, _ = req("/api/v1/redeem", "POST", {"code": good.lower()})
            ok = st_r == 200
            check("H7 a buyer with no key redeems the code -> 200", ok, f"http {st_r} :: {txt_r[:140]}")
            issued = json.loads(txt_r) if ok else {}
            issued_key = issued.get("api_key")
            if ok:
                check("H8 the answer is key + address + quota, nothing else to read",
                      bool(issued_key) and str(issued.get("base_url", "")).endswith("/v1")
                      and issued.get("tokens") == 100000 and issued.get("days") == 30,
                      f"base={issued.get('base_url')} tokens={issued.get('tokens')} days={issued.get('days')}")

                # The key it hands back is a working key.
                st_k, txt_k, _ = chat(ctl_model, issued_key)
                check("H9 the issued key is accepted at /v1", st_k not in (401, 403, 402),
                      f"http {st_k} :: {txt_k[:120]}")

                # ...and a real row: the code's quota and validity are on it.
                con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
                con.row_factory = sqlite3.Row
                found = con.execute("SELECT * FROM apiKeys WHERE metadata LIKE ?", (f"%{good}%",)).fetchone()
                con.close()
                krow = dict(found) if found else {}
                days_out = 0
                if krow.get("expiresAt"):
                    days_out = (datetime.datetime.fromisoformat(krow["expiresAt"].replace("Z", "+00:00"))
                                - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 86400
                check("H10 the issued key carries the code's quota and validity",
                      krow.get("tokenBalance") == 100000 and 29.5 < days_out < 30.5,
                      f"tokenBalance={krow.get('tokenBalance')} days={round(days_out, 2)}")

                rc = raw_code(good)
                check("H11 the code row records exactly one use",
                      bool(rc) and rc.get("usedCount") == 1, f"usedCount={rc.get('usedCount') if rc else None}")

                # A second code mints its own key: redemption never reuses one.
                st_r2, txt_r2, _ = req("/api/v1/redeem", "POST", {"code": codes[1]["code"]})
                second = json.loads(txt_r2) if st_r2 == 200 else {}
                check("H12 the next code mints a different key",
                      st_r2 == 200 and second.get("api_key") and second.get("api_key") != issued_key,
                      f"http {st_r2}")

            st_re, txt_re, _ = req("/api/v1/redeem", "POST", {"code": good})
            check("H13 reusing the same code -> 400", st_re == 400, f"http {st_re} :: {txt_re[:140]}")

            st_un, txt_un, _ = req("/api/v1/redeem", "POST", {"code": "ZZZZ-ZZZZ-ZZZZ"})
            check("H14 unknown code -> 400 (not 500)", st_un == 400, f"http {st_un} :: {txt_un[:140]}")

            st_nc, txt_nc, _ = req("/api/v1/redeem", "POST", {})
            check("H15 a body with no code -> 400", st_nc == 400, f"http {st_nc} :: {txt_nc[:140]}")

            # A revoked code cannot be spent even though it was never used.
            st_rv, _, _ = admin(f"/api/redeem-codes/{codes[1]['id']}", "DELETE")
            st_try, txt_try, _ = req("/api/v1/redeem", "POST", {"code": codes[1]["code"]})
            check("H16 revoked code -> 400", st_rv in (200, 204) and st_try == 400,
                  f"revoke={st_rv} redeem={st_try} :: {txt_try[:120]}")

        # The observability writer buffers rows and flushes on a timer, so the
        # row for the request above lands a few seconds later: poll, don't race.
        lj, st_lg, txt_lg = {}, 0, ""
        for _ in range(12):
            st_lg, txt_lg, _ = admin(f"/api/keys/{bal_id}/logs?pageSize=5")
            if st_lg == 200:
                lj = json.loads(txt_lg)
                if (lj.get("stats", {}).get("requests") or 0) > 0 and lj.get("details"):
                    break
            time.sleep(2)
        if st_lg == 200:
            check("J1 per-key log rollup counts the traffic", (lj.get("stats", {}).get("requests") or 0) > 0,
                  f"stats={lj.get('stats')}")
            check("J2 per-key log returns detail rows", len(lj.get("details", [])) > 0,
                  f"rows={len(lj.get('details', []))}")
        else:
            check("J1 per-key log rollup counts the traffic", False, f"http {st_lg} :: {txt_lg[:140]}")
            check("J2 per-key log returns detail rows", False, "skipped: logs endpoint failed")

        st_lg2, _, _ = admin("/api/keys/does-not-exist/logs")
        check("J3 unknown key log -> 404", st_lg2 == 404, f"http {st_lg2}")
    else:
        for name in ("H1 create with tokenBalance -> 201 and echoed", "H2 first request against a fresh balance passes",
                     "H3 the completed request is debited from the balance", "H4 balance below spend -> request refused",
                     "H5 admin mints a redeem-code batch", "J1 per-key log rollup counts the traffic",
                     "J2 per-key log returns detail rows", "J3 unknown key log -> 404"):
            check(name, False, f"create http {st}")

    # ---- I. batch mint ----------------------------------------------------
    st, txt, _ = admin("/api/keys", "POST", {"name": f"zz-resale-batch-{stamp}", "quantity": 3,
                                             "limits": {"rpm": 20}, "allowedKinds": ["llm"]})
    batch_ids = []
    if st == 201:
        bj = json.loads(txt)
        batch_ids = [k["id"] for k in bj.get("keys", [])]
        check("I1 quantity=3 mints three distinct keys", bj.get("count") == 3 and len(set(batch_ids)) == 3,
              f"count={bj.get('count')}")
        check("I2 batch keys are individually named",
              [k["name"] for k in bj.get("keys", [])] == [f"zz-resale-batch-{stamp} #{i}" for i in (1, 2, 3)],
              f"names={[k['name'] for k in bj.get('keys', [])]}")
        check("I3 a malformed allow-list is refused, not silently dropped",
              admin("/api/keys", "POST", {"name": "zz-bad", "allowedIps": "203.0.113.7"})[0] == 400)
    else:
        check("I1 quantity=3 mints three distinct keys", False, f"http {st}")
        check("I2 batch keys are individually named", False, f"http {st}")
        check("I3 a malformed allow-list is refused, not silently dropped", False, f"http {st}")

    st, txt, _ = admin("/api/redeem-codes")
    if st == 200:
        rj = json.loads(txt)
        check("K1 admin lists redeem codes with a summary", rj.get("count", 0) > 0 and "summary" in rj,
              f"count={rj.get('count')} summary={rj.get('summary')}")
    else:
        check("K1 admin lists redeem codes with a summary", False, f"http {st} :: {txt[:140]}")

    # A buyer must not be able to mint or read codes. Locally the dashboard guard
    # trusts loopback (internal trust), so this is only meaningful against the
    # remote deployment.
    if "127.0.0.1" in BASE or "localhost" in BASE:
        print("[SKIP] K2 buyer key against /api/redeem-codes (loopback is internal-trusted)", flush=True)
    else:
        st_b, _, _ = req("/api/redeem-codes", "GET", None, {"Authorization": f"Bearer {key}"})
        check("K2 buyer key cannot list redeem codes", st_b in (401, 403), f"http {st_b}")

    # ---- N. wave 3: resale dashboard page + buyer diagnosis --------------
    # The dashboard is login-gated, so an unauthenticated fetch cannot read the
    # page HTML. Two facts are still testable from out here: the route EXISTS
    # (the complaint that prompted this page was "there is no page anywhere",
    # i.e. a 404) and it is guarded (307 -> /masuk). The page's own copy is
    # checked against the client chunk the browser loads once logged in.
    st_page, txt_page, _ = req("/dashboard/resale", "GET")
    check("N1 /dashboard/resale exists and is login-guarded",
          st_page in (200, 307), f"http {st_page}")

    chunk_root = os.path.join(REPO, ".next", "standalone", ".next", "static", "chunks")
    page_chunk = None
    sidebar_src = ""
    for root, _dirs, files in os.walk(chunk_root):
        for f in files:
            if not f.endswith(".js"):
                continue
            full = os.path.join(root, f)
            if os.sep + "resale" + os.sep in root + os.sep and f.startswith("page"):
                page_chunk = full
            elif not sidebar_src and "/dashboard/resale" in open(full, encoding="utf-8", errors="replace").read():
                sidebar_src = full
    page_src = open(page_chunk, encoding="utf-8", errors="replace").read() if page_chunk else ""

    # The buyer's page is static copy, so its text is assertable from its chunk.
    buyer_chunk = ""
    for root, _dirs, files in os.walk(chunk_root):
        if os.sep + "tukar" + os.sep not in root + os.sep:
            continue
        for f in files:
            if f.endswith(".js") and f.startswith("page"):
                buyer_chunk = os.path.join(root, f)
    buyer_src = open(buyer_chunk, encoding="utf-8", errors="replace").read() if buyer_chunk else ""

    check("N2 the resale page chunk ships in the built artifact",
          bool(page_chunk) and "/api/redeem-codes" in page_src,
          f"chunk={os.path.basename(page_chunk) if page_chunk else 'absent'}")
    check("N3 the shipped resale page points the buyer at the redeem page",
          "/tukar" in page_src, f"page={os.path.basename(page_chunk) if page_chunk else 'absent'}")
    check("N3b the shipped page reads the public base URL setting",
          "publicBaseUrl" in page_src, f"page={os.path.basename(page_chunk) if page_chunk else 'absent'}")
    check("N3c the buyer page ships with its own copy and the code field",
          bool(buyer_chunk) and "Masukkan kode pembelian" in buyer_src and "base_url" in buyer_src,
          f"chunk={os.path.basename(buyer_chunk) if buyer_chunk else 'absent'}")
    check("N4 the sidebar links the page",
          bool(sidebar_src) or 'href="/dashboard/resale"' in txt_page,
          f"nav entry absent (chunk={os.path.basename(sidebar_src) if sidebar_src else 'none'})")

    # A seller must be able to check a key before shipping it: the two calls a
    # buyer makes first, read-only, with the reason spelled out.
    st_me, txt_me, _ = req("/v1/key", "GET", None, {"Authorization": f"Bearer {key}"})
    ok_me = st_me == 200
    check("N5 GET /v1/key answers the buyer's own key", ok_me, f"http {st_me} :: {txt_me[:140]}")
    if ok_me:
        mj = json.loads(txt_me)
        check("N6 the self-check exposes the remaining balance", "remainingTokens" in mj,
              f"keys={sorted(mj.keys())[:12]}")
        # A gate code belongs to a CLOSED gate. On an open gate the honest answer
        # is "allowed, no reason" — a code there would be noise the buyer has to
        # filter, and a seller reading it would think something was wrong.
        gate = mj.get("gate") or {}
        if gate.get("allowed"):
            check("N7 an open gate reports no blocking code",
                  gate.get("code") in (None, "") and not gate.get("reason"),
                  f"gate={gate}")
        else:
            check("N7 a closed gate names its code", bool(gate.get("code")), f"gate={gate}")
        check("N8 the self-check reports the source address", bool(mj.get("sourceIp")),
              f"sourceIp={mj.get('sourceIp')}")

    st_bad, txt_bad, _ = req("/v1/key", "GET", None, {"Authorization": "Bearer not-a-real-key"})
    check("N9 an unknown key is 401 with its own code", st_bad == 401 and "api_key_unknown" in txt_bad,
          f"http {st_bad} :: {txt_bad[:140]}")

    st_mod, txt_mod, _ = req("/v1/models", "GET", None, {"Authorization": f"Bearer {key}"})
    ok_mod = st_mod == 200
    check("N10 GET /v1/models answers a valid buyer key", ok_mod, f"http {st_mod} :: {txt_mod[:140]}")
    if ok_mod:
        mj = json.loads(txt_mod)
        models = mj.get("data") or []
        check("N11 the model list is non-empty for an unrestricted key", len(models) > 0,
              f"count={len(models)}")
        check("N12 every entry carries an id", all(m.get("id") for m in models[:20]),
              f"sample={[m.get('id') for m in models[:5]]}")

    # ---- E. delete --------------------------------------------------------
    st, _, _ = admin(f"/api/keys/{kid}", "DELETE")
    check("E1 delete -> 200", st in (200, 204), f"http {st}")
    st, txt, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {key}"})
    check("E2 deleted key dead", st in (401, 403), f"http {st}")
    if expired_id:
        st, _, _ = admin(f"/api/keys/{expired_id}", "DELETE")
        check("E3 expired key cleaned up", st in (200, 204), f"http {st}")
    for extra, label in ((combo_id, "combo key"), (kind_id, "kind key"), (model_key_id, "model key"),
                         (rpm_id, "rpm key"), (tok_id, "maxTokens key"), (ip_id, "IP-bound key"),
                         (bal_id, "prepaid key"), (open_id, "control key"),
                         (ipbad_id, "blocked-address key")):
        if extra:
            st, _, _ = admin(f"/api/keys/{extra}", "DELETE")
            check(f"E4 {label} cleaned up", st in (200, 204), f"http {st}")
    for extra in batch_ids:
        st, _, _ = admin(f"/api/keys/{extra}", "DELETE")
        check("E5 batch key cleaned up", st in (200, 204), f"http {st}")
    for extra in code_ids:
        st, _, _ = admin(f"/api/redeem-codes/{extra}?purge=1", "DELETE")
        check("E6 redeem code purged", st in (200, 204), f"http {st}")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n=== {passed}/{len(results)} PASS ===")
    for n, ok, _ in results:
        if not ok:
            print(f"  FAILED: {n}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
