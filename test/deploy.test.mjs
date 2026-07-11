import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const deploy = new URL('../deploy/', import.meta.url)

async function file(name) {
  return readFile(new URL(name, deploy), 'utf8')
}

test('runs a token-holding transport service without a VPS Codex dependency', async () => {
  const bridge = await file('codex-tg-bridge.service')

  assert.match(bridge, /^User=tgbridge$/m)
  assert.match(bridge, /^LoadCredential=telegram-token:/m)
  assert.match(bridge, /^Environment=TELEGRAM_TOKEN_FILE=\/run\/credentials\/%n\/telegram-token$/m)
  assert.match(bridge, /^ExecStart=\/usr\/local\/bin\/node \/opt\/tg-engage\/bridge\/src\/transport-index\.mjs$/m)
  assert.doesNotMatch(bridge, /codex-tg-app|APP_SERVER_SOCKET|CODEX_HOME/)
})

test('hardens the transport while keeping only its durable state writable', async () => {
  const bridge = await file('codex-tg-bridge.service')

  assert.match(bridge, /^ProtectSystem=strict$/m)
  assert.match(bridge, /^PrivateTmp=true$/m)
  assert.match(bridge, /^NoNewPrivileges=true$/m)
  assert.match(bridge, /^ReadOnlyPaths=\/opt\/tg-engage$/m)
  assert.match(bridge, /^ReadWritePaths=\/var\/lib\/codex-tg-bridge$/m)
})

test('installer requires Node only and does not provision a cloud Codex runtime', async () => {
  const install = await file('install.sh')

  assert.match(install, /\/usr\/local\/bin\/node --version/)
  assert.match(install, /\/usr\/local\/bin\/npm --version/)
  assert.match(install, /systemd-analyze verify \/etc\/systemd\/system\/codex-tg-bridge\.service/)
  assert.doesNotMatch(install, /codex --version|codexbot|generate-json-schema|codex-tg-app\.service/)
  assert.doesNotMatch(install, /TELEGRAM_BOT_TOKEN=/)
})

test('user release staging installs an isolated verified Node without touching service state', async () => {
  const stage = await file('stage-user-release.sh')

  assert.match(stage, /^NODE_VERSION=\$\{NODE_VERSION:-v24\.18\.0\}$/m)
  assert.match(stage, /https:\/\/nodejs\.org\/dist\/\$\{NODE_VERSION\}/)
  assert.match(stage, /sha256sum/)
  assert.match(stage, /\.local\/share\}\/codex-tg-bridge/)
  assert.match(stage, /"\$\{node_binary\}" --check/)
  assert.match(stage, /"\$\{npm_cli\}" test/)
  assert.match(stage, /service_changed=false/)
  assert.doesNotMatch(stage, /systemctl|sudo|\/usr\/bin\/node|\/usr\/local\/bin\/node/)
  assert.doesNotMatch(stage, /\.bridge-state|TELEGRAM_TOKEN|credentials/)
})
