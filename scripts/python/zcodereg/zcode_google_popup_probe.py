#!/usr/bin/env python3
"""Probe how chat.z.ai opens the Google SSO popup for the ZCode OAuth flow.

Hooks window.open + popup events before clicking .ButtonContinueWithGoogle so we
learn the exact Google URL (and whether a popup is even attempted in headless
mode). Prints the captured URL so a caller can navigate to it directly.
"""
import sys
import time

sys.path.insert(0, "/home/ubuntu/VansRouter/scripts/python/zcodereg")
import zcode_cli_oauth_gsuite as Z  # noqa: E402

from camoufox.sync_api import Camoufox  # noqa: E402


def main():
    _, flow_id, url = Z.init_flow()
    print(f"flow={flow_id}")
    opened = []
    pages = []
    with Camoufox(headless=True, proxy={"server": Z.WARP}, geoip=True) as b:
        ctx = b.new_context()
        ctx.on("page", lambda p: pages.append(p))
        page = ctx.new_page()
        page.add_init_script(
            """
            window.__opened = [];
            const orig = window.open;
            window.open = function(u, ...rest) {
              window.__opened.push(String(u));
              return orig.call(window, u, ...rest);
            };
            window.addEventListener('message', e => { window.__opened.push('MSG:' + String(e.origin)); });
        """
        )
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        time.sleep(8)
        print("selector present:", bool(page.query_selector(".ButtonContinueWithGoogle")))
        page.click(".ButtonContinueWithGoogle", timeout=15000)
        time.sleep(8)
        captured = page.evaluate("() => window.__opened || []")
        print("window.open calls:", captured)
        print("ctx pages:", [p.url[:120] for p in pages])
        print("main url:", page.url[:120])
        if not captured:
            # maybe the handler builds the URL via an API call; watch requests
            reqs = page.evaluate("() => performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/google|oauth|auth/i.test(n)).slice(0,20)")
            print("resource hints:", reqs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
