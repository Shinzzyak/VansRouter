"""qoderreg — Qoder bulk registration CLI (chromium-only, no cv2/camoufox).

Port of grok-register/qoder_bulk.py + qoder_browser.py + solve_slider_v2.py.
YYDS temp mail + PKCE device auth + Playwright chromium signup flow.
Output: one JSON line per account on stdout.
"""
__version__ = "0.1.0"
