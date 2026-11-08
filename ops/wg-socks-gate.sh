#!/usr/bin/env bash
# wg-socks-gate — per-pool egress isolation WITHOUT touching the router engine.
#
# The router already has a per-connection proxy-pool system
# (src/lib/network/connectionProxy.js). Each proxy pool's proxyUrl is just a
# URL; if that URL is a local SOCKS5 listener whose egress is pinned to its own
# WireGuard tunnel, a pool gets a dedicated egress IP with ZERO core-code
# changes. This script provisions those listeners + tunnels:
#
#   [gate1] wg1 -> gost socks5 127.0.0.1:11081 (uid 2001) -> table 1001 -> wg1
#   [gate2] wg2 -> gost socks5 127.0.0.1:11082 (uid 2002) -> table 1002 -> wg2
#
# Ports: use 11081+ — 1080-1088 on this box are taken (docker-proxy/pub infra).
#
# Steering: each gost daemon runs under its OWN uid; an ip rule
# (uidrange -> table N) routes that daemon's outbound packets into the tunnel's
# routing table. The router process is untouched, so its non-proxied traffic
# stays on the default route.
#
# Config: /etc/wg-socks-gate.conf, one entry per line, no comments allowed:
#   <wg-interface-name>:<socks-port>:<uid>   (wg name <=15 chars, IFNAMSIZ)
# The WG client conf itself lives at /etc/wireguard/<name>.conf — the same
# place the dashboard Import .conf flow writes it (0700 root, private key
# never leaves the box).
#
# Usage:
#   wg-socks-gate.sh install-gost   # one-time: fetch/verify/place gost binary
#   wg-socks-gate.sh up             # bring up every tunnel + gost per config
#   wg-socks-gate.sh status         # listeners, uids, rules, tunnel state
#   wg-socks-gate.sh down           # stop + disable everything
# All commands idempotent; safe to re-run at every deploy.

set -euo pipefail

CONF="/etc/wg-socks-gate.conf"
WG_DIR="/etc/wireguard"
GOST_BIN="/usr/local/bin/gost"
GOST_VER="2.11.5"
GOST_URL="https://github.com/ginuerzh/gost/releases/download/v${GOST_VER}/gost-linux-amd64-${GOST_VER}.gz"
# ponytail: pinned version, no sha gate; upgrade = bump version + verify with
#           `gost -V` after install. Add a sha256sum check when gost publishes
#           a checksum file alongside the tarball.

need_root() { if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi; }

install_gost() {
  need_root
  if [ -x "${GOST_BIN}" ] && "${GOST_BIN}" -V 2>/dev/null | grep -q "${GOST_VER}"; then
    echo "gost ${GOST_VER} already present"; return 0
  fi
  local tmp; tmp="$(mktemp -d)"
  echo "fetching gost ${GOST_VER}..."
  curl -fsSL -o "${tmp}/gost.gz" "${GOST_URL}"
  gzip -dc "${tmp}/gost.gz" > "${tmp}/gost"
  chmod +x "${tmp}/gost"
  install -m 0755 "${tmp}/gost" "${GOST_BIN}"
  rm -rf "${tmp}"
  "${GOST_BIN}" -V
  echo "gost installed at ${GOST_BIN}"
}

read_entries() {
  [ -f "${CONF}" ] || return 0
  while IFS=: read -r name port uid; do
    [ -z "${name:-}" ] && continue
    # validation: wg name <=15 (IFNAMSIZ-1), port in range, uid numeric
    [ "${#name}" -le 15 ] || { echo "BAD CONF: ${name} > 15 chars" >&2; exit 1; }
    case "${name}" in *[^a-zA-Z0-9_-]* ) echo "BAD CONF: ${name} has bad char" >&2; exit 1;; esac
    [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || { echo "BAD CONF: port ${port}" >&2; exit 1; }
    [[ "${uid}" =~ ^[0-9]+$ ]] || { echo "BAD CONF: uid ${uid}" >&2; exit 1; }
    echo "${name} ${port} ${uid}"
  done < "${CONF}"
}

gate_up() {
  need_root
  local name port uid table
  while read -r name port uid; do
    table=$((1000 + port % 100))
    [ -f "${WG_DIR}/${name}.conf" ] || { echo "skip ${name}: no ${WG_DIR}/${name}.conf"; continue; }
    # tunnel (wg-quick, systemd-managed; idempotent)
    systemctl enable --now "wg-quick@${name}" >/dev/null 2>&1 || true
    ip link show "${name}" >/dev/null 2>&1 || wg-quick up "${name}"
    # dedicated uid
    if ! id -u "gst-${name}" >/dev/null 2>&1; then
      useradd -r -M -u "${uid}" -s /usr/sbin/nologin "gst-${name}" 2>/dev/null \
        || useradd -r -M -s /usr/sbin/nologin "gst-${name}"
    fi
    local actual_uid; actual_uid="$(id -u "gst-${name}")"
    # routing table + uid rule for THIS daemon's packets
    ip rule del uidrange "${actual_uid}"-"${actual_uid}" lookup "${table}" 2>/dev/null || true
    ip rule add uidrange "${actual_uid}"-"${actual_uid}" lookup "${table}" priority 1200
    ip route replace default dev "${name}" table "${table}"
    # gost systemd unit
    cat > "/etc/systemd/system/gst-${name}.service" <<EOF
[Unit]
Description=WG socks gate ${name} (uid ${actual_uid} -> ${name})
After=network-online.target wg-quick@${name}.service
Wants=wg-quick@${name}.service
[Service]
ExecStart=${GOST_BIN} -L socks5://127.0.0.1:${port}
User=gst-${name}
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "gst-${name}.service" >/dev/null 2>&1 || systemctl restart "gst-${name}.service"
    echo "gate ${name}: socks5 127.0.0.1:${port} uid ${actual_uid} table ${table}"
  done < <(read_entries)
}

gate_down() {
  need_root
  while read -r name port uid; do
    systemctl disable --now "gst-${name}.service" 2>/dev/null || true
    ip rule del priority 1200 2>/dev/null || true
    wg-quick down "${name}" 2>/dev/null || true
    systemctl disable "wg-quick@${name}" 2>/dev/null || true
    echo "down: ${name}"
  done < <(read_entries)
}

gate_status() {
  echo "=== entries (${CONF:-}) ==="
  read_entries || true
  echo "=== listeners ==="
  ss -lntp 2>/dev/null | grep -E "gost|:108[0-9]" || echo "  (none)"
  echo "=== uid rules ==="
  ip rule show | grep -E "uidrange|lookup 1[0-9]{3}" || echo "  (none)"
  echo "=== tunnels ==="
  ip -br link show type wireguard 2>/dev/null || echo "  (none)"
  echo "=== gost units ==="
  systemctl list-units --no-legend "gst-*.service" 2>/dev/null | head -20 || true
}

case "${1:-}" in
  install-gost) install_gost ;;
  up) gate_up ;;
  down) gate_down ;;
  status) gate_status ;;
  *) echo "usage: $0 {install-gost|up|down|status}"; exit 1 ;;
esac
