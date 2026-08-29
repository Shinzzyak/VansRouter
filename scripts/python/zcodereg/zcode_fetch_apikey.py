#!/usr/bin/env python3
"""Fetch & test coding-plan API key per akun (z/login -> customer -> apiKeys),
lalu test chat api.z.ai coding-plan (lihat apakah 300M token grant aktif)."""
import sys, os, json, subprocess, urllib.request, urllib.error, time

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"


def api_req(method, url, body=None, auth=None, timeout=25):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if auth: h["Authorization"] = f"Bearer {auth}"
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {"raw": e.read().decode()[:200]}


def get_acc(email):
    out = subprocess.run(["node", "-e", f'''
const {{DatabaseSync}}=require("node:sqlite");
const db=new DatabaseSync("{DB}");
const r=db.prepare("SELECT data FROM providerConnections WHERE provider='zcode' AND email=?").get("{email}");
if(!r){{console.log(JSON.stringify({{}}));process.exit(0);}}
const d=JSON.parse(r.data);
console.log(JSON.stringify({{at: d.accessToken||"", psd: d.providerSpecificData||{{}}}}));
'''], cwd="/home/ubuntu/VansRouter", capture_output=True, text=True)
    try:
        return json.loads(out.stdout.strip())
    except Exception:
        return None


def process(email):
    acc = get_acc(email)
    if not acc or not acc.get("at"):
        print(f"[{email}] NO accessToken")
        return None
    at = acc["at"]

    # 1) z/login -> biz
    st, j = api_req("POST", "https://api.z.ai/api/auth/z/login", {"token": at})
    biz = (j.get("data") or {}).get("access_token", "") if isinstance(j, dict) else ""
    if not biz:
        print(f"[{email}] z/login fail: {st} {json.dumps(j)[:120]}")
        return None
    print(f"[{email}] biz ok ({len(biz)}c)")

    # 2) customer info
    st, j = api_req("GET", "https://api.z.ai/api/biz/customer/getCustomerInfo", auth=biz)
    if st != 200 or not j.get("data"):
        print(f"[{email}] customer fail: {st} {json.dumps(j)[:150]}")
        return None
    org = j["data"]["organizations"][0]
    org_id = org.get("organizationId") or org["id"]
    proj = (org.get("projects") or [{}])[0]
    proj_id = proj.get("projectId") or proj.get("id") or ""
    print(f"[{email}] org={org_id} proj={proj_id}")

    # 3) apiKeys
    st, j = api_req("GET", f"https://api.z.ai/api/biz/v1/organization/{org_id}/projects/{proj_id}/api_keys", auth=biz)
    keys = (j.get("data") or j.get("list") or [])
    if not keys:
        print(f"[{email}] NO api keys")
        return None
    k = keys[0]
    api_key = k.get("apiKey", "") + "." + k.get("secretKey", "") if k.get("secretKey") else k.get("apiKey", "")
    print(f"[{email}] key: {api_key[:25]}... len={len(api_key)}")

    # 4) test chat
    body = {"model": "glm-5.3-flash", "messages": [{"role": "user", "content": "say hi"}], "max_tokens": 20}
    st, j = api_req("POST", "https://api.z.ai/api/coding/paas/v4/chat/completions", body, auth=api_key)
    print(f"[{email}] chat: {st} {json.dumps(j)[:200]}")

    # save keys ke DB
    out = subprocess.run(["node", "-e", f'''
const {{DatabaseSync}}=require("node:sqlite");
const db=new DatabaseSync("{DB}");
const r=db.prepare("SELECT data FROM providerConnections WHERE email=?").get("{email}");
if(r){{
  const d=JSON.parse(r.data);
  const psd=d.providerSpecificData||{{}};
  psd.apiKey="{k.get('apiKey','')}";
  psd.secretKey="{k.get('secretKey','')}";
  psd.businessToken="{biz}";
  db.prepare("UPDATE providerConnections SET data=? WHERE email=?").run(JSON.stringify(d), "{email}");
  console.log("saved");
}}
'''], cwd="/home/ubuntu/VansRouter", capture_output=True, text=True)
    print("  saved:", out.stdout.strip()[:60])
    return {"email": email, "chat": st, "key": api_key[:30]}


if __name__ == "__main__":
    email = sys.argv[1] if len(sys.argv) > 1 else "justin.stewart@e-mail.bty.web.id"
    process(email)