#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'install.sh must run as root\n' >&2
  exit 1
fi

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_ROOT=/opt/codex-tg-bridge
/usr/local/bin/node --version
/usr/local/bin/npm --version

NODE_MAJOR=$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')
if [[ ${NODE_MAJOR} -ne 24 ]]; then
  printf 'Node.js 24 LTS is required; found major %s\n' "$NODE_MAJOR" >&2
  exit 1
fi

id tgbridge >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/codex-tg-bridge --shell /usr/sbin/nologin tgbridge

install -d -o root -g root -m 0755 "$INSTALL_ROOT"
cp -a "$SOURCE_ROOT/." "$INSTALL_ROOT/"
chown -R root:root "$INSTALL_ROOT"
cd "$INSTALL_ROOT"
/usr/local/bin/npm ci --omit=dev

install -D -o root -g root -m 0644 "$SOURCE_ROOT/deploy/codex-tg-bridge.service" /etc/systemd/system/codex-tg-bridge.service
/usr/bin/systemd-analyze verify /etc/systemd/system/codex-tg-bridge.service
install -d -o root -g tgbridge -m 0750 /etc/codex-tg-bridge

if [[ ! -e /etc/codex-tg-bridge/bridge.env ]]; then
  install -o root -g tgbridge -m 0640 "$SOURCE_ROOT/.env.example" /etc/codex-tg-bridge/bridge.env.example
fi

systemctl daemon-reload
printf '%s\n' \
  'Installation complete; services were not enabled.' \
  'Next: configure /etc/codex-tg-bridge/bridge.env and telegram-token,' \
  'then run the documented transport and SSH relay preflight.'
