#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'install.sh must run as root\n' >&2
  exit 1
fi

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INSTALL_ROOT=/opt/tg-engage
SCHEMA_DIR=$(mktemp -d)
trap 'rm -rf "$SCHEMA_DIR"' EXIT

/usr/local/bin/node --version
/usr/local/bin/npm --version
/usr/local/bin/codex --version

NODE_MAJOR=$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')
if [[ ${NODE_MAJOR} -ne 24 ]]; then
  printf 'Node.js 24 LTS is required; found major %s\n' "$NODE_MAJOR" >&2
  exit 1
fi

SWAP_KB=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
if [[ ${SWAP_KB:-0} -lt 2097152 ]]; then
  printf 'At least 2 GiB swap is required before deployment\n' >&2
  exit 1
fi

getent group codex-tg >/dev/null || groupadd --system codex-tg
getent group codex-tg-wake >/dev/null || groupadd --system codex-tg-wake
id codexbot >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/codexbot --shell /usr/sbin/nologin codexbot
id tgbridge >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/codex-tg-bridge --shell /usr/sbin/nologin tgbridge
usermod -a -G codex-tg codexbot
usermod -a -G codex-tg,codex-tg-wake tgbridge

install -d -o root -g root -m 0755 "$INSTALL_ROOT/bridge"
cp -a "$SOURCE_ROOT/bridge/." "$INSTALL_ROOT/bridge/"
chown -R root:root "$INSTALL_ROOT"
cd "$INSTALL_ROOT/bridge"
/usr/local/bin/npm ci --omit=dev

install -D -o root -g root -m 0644 "$SOURCE_ROOT/bridge/deploy/tmpfiles.conf" /usr/lib/tmpfiles.d/codex-tg.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/codex-tg.conf
install -D -o root -g root -m 0644 "$SOURCE_ROOT/bridge/deploy/codex-tg-app.service" /etc/systemd/system/codex-tg-app.service
install -D -o root -g root -m 0644 "$SOURCE_ROOT/bridge/deploy/codex-tg-bridge.service" /etc/systemd/system/codex-tg-bridge.service
/usr/bin/systemd-analyze verify \
  /etc/systemd/system/codex-tg-app.service \
  /etc/systemd/system/codex-tg-bridge.service
install -d -o root -g tgbridge -m 0750 /etc/codex-tg-bridge

CODEX_VERSION=$(/usr/local/bin/codex --version)
runuser -u codexbot -- env HOME=/var/lib/codexbot CODEX_HOME=/var/lib/codexbot/.codex \
  /usr/local/bin/codex app-server generate-json-schema --experimental --out "$SCHEMA_DIR"
install -d -o root -g root -m 0755 "$INSTALL_ROOT/bridge/fixtures/deployed"
/usr/local/bin/node "$INSTALL_ROOT/bridge/scripts/capture-codex-contract.mjs" \
  --schema-dir "$SCHEMA_DIR" \
  --codex-version "$CODEX_VERSION" \
  --out "$INSTALL_ROOT/bridge/fixtures/deployed/contract.json"

if [[ ! -e /etc/codex-tg-bridge/bridge.env ]]; then
  install -o root -g tgbridge -m 0640 "$SOURCE_ROOT/bridge/.env.example" /etc/codex-tg-bridge/bridge.env.example
fi

systemctl daemon-reload
printf '%s\n' \
  'Installation complete; services were not enabled.' \
  'Next: configure /etc/codex-tg-bridge/bridge.env and telegram-token,' \
  'log in to Codex as codexbot, then run the documented preflight.'
