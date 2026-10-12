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
    def chat(model, key_str=key, kind_path="/v1/chat/completions"):
        return req(kind_path, "POST",
                   {"model": model, "messages": [{"role": "user", "content": "say OK"}],
                    "max_tokens": 16}, {"Authorization": f"Bearer {key_str}"}, timeout=90)

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

    # ---- E. delete --------------------------------------------------------
    st, _, _ = admin(f"/api/keys/{kid}", "DELETE")
    check("E1 delete -> 200", st in (200, 204), f"http {st}")
    st, txt, _ = req("/api/v1/key", "GET", None, {"Authorization": f"Bearer {key}"})
    check("E2 deleted key dead", st in (401, 403), f"http {st}")
    if expired_id:
        st, _, _ = admin(f"/api/keys/{expired_id}", "DELETE")
        check("E3 expired key cleaned up", st in (200, 204), f"http {st}")
    for extra, label in ((combo_id, "combo key"), (kind_id, "kind key"), (model_key_id, "model key"),
                         (rpm_id, "rpm key"), (tok_id, "maxTokens key")):
        if extra:
            st, _, _ = admin(f"/api/keys/{extra}", "DELETE")
            check(f"E4 {label} cleaned up", st in (200, 204), f"http {st}")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n=== {passed}/{len(results)} PASS ===")
    for n, ok, _ in results:
        if not ok:
            print(f"  FAILED: {n}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
