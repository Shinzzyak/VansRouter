#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[smoke] building zero-CGO binary..."
CGO_ENABLED=0 go build -o vansroute ./cmd/server

PORT="${PORT:-20300}"
DATA_DIR="$(mktemp -d)"
export DATA_DIR
export PORT
export INITIAL_PASSWORD="smoke-test-password"
export API_KEY_SECRET="smoke-api-key-secret"
export JWT_SECRET="smoke-jwt-secret-smoke-jwt-secret"
export REQUIRE_API_KEY="false"

cleanup() {
  if [[ -n "${pid:-}" ]]; then
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  fi
  rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

echo "[smoke] starting ./vansroute on port ${PORT}..."
./vansroute >"${DATA_DIR}/vansroute.log" 2>&1 &
pid=$!

for i in {1..30}; do
  if curl -fs "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[smoke] health check..."
curl -fs "http://127.0.0.1:${PORT}/health" | grep -q '"status":"ok"'

echo "[smoke] version check..."
curl -fs "http://127.0.0.1:${PORT}/version" | grep -q 'currentVersion'

echo "[smoke] all checks passed"
