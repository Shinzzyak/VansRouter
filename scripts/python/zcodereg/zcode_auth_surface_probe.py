#!/usr/bin/env python3
"""Probe: what does the zcode.z.ai authorize_url show before login?

Runs the live CLI-init flow, opens the returned authorize_url in Camoufox via
WARP, and dumps the interactive surface (URL, visible buttons/links, whether a
Google SSO entry point exists). No credentials are used.

Usage: python3 zcode_auth_surface_probe.py
"""
import json
import secrets
import sys
import time

import requests

WARP = "socks5h://127.0.0.1:40000"
INIT = "https://zcode.z.ai/api/v1/oauth/cli/init"


def init_flow():
    poll_token = secrets.token_hex(32)
    r = requests.post(
        INIT,
        json={"provider": "zai"},
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {poll_token}"},
        proxies={"https": WARP, "http": WARP},
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()["data"]
    return poll_token, d["flow_id"], d["authorize_url"], d


def main():
    poll_token, flow_id, auth_url, data = init_flow()
    print(f"flow_id={flow_id}")
    print(f"authorize_url={auth_url[:160]}")
    print(f"keys={sorted(data.keys())}")
    print(f"poll_token_chars={len(poll_token)}")

    from camoufox.sync_api import Camoufox

    with Camoufox(headless=True, proxy={"server": WARP}) as browser:
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(auth_url, wait_until="domcontentloaded", timeout=90000)
        time.sleep(8)
        print(f"\nlanded_url={page.url[:200]}")
        info = page.evaluate(
            """() => {
            const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
            const btns = [...document.querySelectorAll('button,[role=button],a')]
              .filter(vis).map(e => ({tag:e.tagName, text:(e.innerText||'').trim().slice(0,60),
                                      href:(e.getAttribute('href')||'').slice(0,120)}))
              .filter(x => x.text || x.href);
            const inputs = [...document.querySelectorAll('input')].filter(vis)
              .map(e => ({type:e.type, name:e.name, id:e.id, ph:e.placeholder||''}));
            return {title:document.title, url:location.href,
                    text:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,900),
                    btns, inputs};
        }"""
        )
        print(f"title={info['title']}")
        print(f"text={info['text'][:900]}")
        print("\nbuttons/links:")
        for b in info["btns"][:30]:
            print(f"  {b['tag']:6} | {b['text'][:50]:50} | {b['href'][:80]}")
        print("\ninputs:")
        for i in info["inputs"][:15]:
            print(f"  {i}")
        google = [b for b in info["btns"] if "google" in (b["text"] + b["href"]).lower()]
        print(f"\ngoogle_entry_points={len(google)}")
        for g in google:
            print(f"  {g}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
