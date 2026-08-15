#!/usr/bin/env python3
"""Kiro: refresh token → ListAvailableModels + usage + models per akun."""
import sys, json, urllib.request, urllib.error

def get_token(rt):
    req = urllib.request.Request(
        "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
        data=json.dumps({"refreshToken": rt}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "kiro-cli/1.0.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

def list_models(at, arn):
    req = urllib.request.Request(
        f"https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&profileArn={urllib.parse.quote(arn)}",
        headers={
            "Authorization": f"Bearer {at}",
            "x-amz-user-agent": "aws-sdk-js/1.0.0 ua/2.1 os/Linux lang/js md/browser#Chrome_126",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())

# cek satu akun
cookies = {}
for line in open("/tmp/kiro_batch/acc_000.txt").read().strip().split("\n"):
    p = line.split("\t")
    if len(p) >= 3:
        cookies[p[0]] = p[2]

rt = cookies.get("RefreshToken", "")
tok = get_token(rt)
at = tok.get("accessToken", "")
arn = tok.get("profileArn", "")
print(f"ARN: {arn}")
print(f"AT: {at[:30]}...")

models = list_models(at, arn)
print(f"=== MODELS ({len(models.get('models', []))}) ===")
for m in models.get("models", []):
    print(f"  {m.get('modelName') or m.get('modelId')} | {m.get('modelArn','')}")
