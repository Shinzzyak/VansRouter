#!/usr/bin/env bash
# chatgptreg — ChatGPT bulk account registration via verssache/chatgpt-creator
# (fork patches: pluggable temp-mail backend → YYDS/Tempik/Driftz via TEMPMAIL_API).
#
# Prereqs (VPS): go >= 1.25, repo clone at $CHATGPT_CREATOR_DIR, residential proxy for
# non-flagged signups (OpenAI anti-bot; datacenter IPs get registration_disallowed).
#
# Usage:
#   CHATGPT_CREATOR_DIR=/opt/chatgpt-creator \
#   TEMPMAIL_API=<yyds-or-tempik-api> TEMPMAIL_TOKEN=<token> \
#   ./chatgptreg.sh --count 5 --proxy http://user:pass@host:port
set -euo pipefail

DIR="${CHATGPT_CREATOR_DIR:-/opt/chatgpt-creator}"
COUNT="${1:-5}"
PROXY=""
[[ "$#" -ge 3 && "$1" == "--count" ]] && COUNT="$2" && PROXY="$4"

if [[ ! -d "$DIR" ]]; then
  echo "clone + patch dulu: git clone https://github.com/verssache/chatgpt-creator $DIR && git apply /tmp/wolfeus-ops/patches/chatgpt-creator-fixes.patch" >&2
  exit 1
fi

if [[ -z "${TEMPMAIL_API:-}" ]]; then
  echo "TEMPMAIL_API wajib (YYDS/Tempik/Driftz base URL)" >&2
  exit 1
fi

echo "=== build chatgpt-creator ==="
(cd "$DIR" && go build -o /tmp/chatgpt-creator-bin .)

echo "=== run $COUNT accounts ==="
if [[ -n "$PROXY" ]]; then
  PROXY="$PROXY" TEMPMAIL_API="$TEMPMAIL_API" TEMPMAIL_TOKEN="${TEMPMAIL_TOKEN:-}" \
    /tmp/chatgpt-creator-bin -count "$COUNT" 2>&1
else
  TEMPMAIL_API="$TEMPMAIL_API" TEMPMAIL_TOKEN="${TEMPMAIL_TOKEN:-}" \
    /tmp/chatgpt-creator-bin -count "$COUNT" 2>&1
fi

echo "=== hasil: results.txt (email|password) di $DIR ==="
tail -"$COUNT" "$DIR/results.txt" 2>/dev/null || true
