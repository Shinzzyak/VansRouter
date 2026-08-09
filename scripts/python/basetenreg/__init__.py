"""basetenreg — Baseten bulk signup CLI (Camoufox/Playwright).

Port of harvest-console grok-register baseten_bulk.py + baseten_browser.py
(available only as patch fragments) into the VansRouter automation stack.

Flow per account:
  1. create YYDS temp inbox (reuses qoderreg._yyds)
  2. browser (camoufox preferred / chromium fallback) → login.baseten.co/sign-up
     (Cloudflare JS challenge — needs anti-detect engine; chromium may be blocked)
  3. fill name/email/password → submit → OTP via YYDS → magic-code redirect
  4. post-signup HTTP continuation with browser cookies:
     waiting room submit → approve → onboarding complete → create API key
  5. emit JSON line {status, email, password, api_key, error}

Output: one JSON line per account on stdout, logs to stderr.
Exit 0 if >=1 success, 2 if all failed.
"""
__version__ = "0.1.0"
