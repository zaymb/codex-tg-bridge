import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const deploy = new URL('../deploy/', import.meta.url)
const execFileAsync = promisify(execFile)

async function file(name) {
  return readFile(new URL(name, deploy), 'utf8')
}

test('keeps Telegram credentials in the tgbridge service only', async () => {
  const app = await file('codex-tg-app.service')
  const bridge = await file('codex-tg-bridge.service')

  assert.match(app, /^User=codexbot$/m)
  assert.doesNotMatch(app, /telegram-token|TELEGRAM_TOKEN|LoadCredential/)
  assert.match(app, /^SupplementaryGroups=codex-tg$/m)
  assert.doesNotMatch(app, /codex-tg-wake/)

  assert.match(bridge, /^User=tgbridge$/m)
  assert.match(bridge, /^LoadCredential=telegram-token:/m)
  assert.match(
    bridge,
    /^Environment=TELEGRAM_TOKEN_FILE=\/run\/credentials\/%n\/telegram-token$/m,
  )
  assert.doesNotMatch(bridge, /%d/)
  assert.match(bridge, /^SupplementaryGroups=codex-tg codex-tg-wake$/m)
})

test('uses separate protected Unix socket directories for app, action, and wake', async () => {
  const tmpfiles = await file('tmpfiles.conf')
  assert.match(tmpfiles, /d \/run\/codex-tg\/app 2750 codexbot codex-tg/)
  assert.match(tmpfiles, /d \/run\/codex-tg\/action 2750 tgbridge codex-tg/)
  assert.match(tmpfiles, /d \/run\/codex-tg\/wake 2750 tgbridge codex-tg-wake/)

  const app = await file('codex-tg-app.service')
  const bridge = await file('codex-tg-bridge.service')
  assert.match(app, /unix:\/\/\/run\/codex-tg\/app\/app\.sock/)
  assert.match(bridge, /BRIDGE_ACTION_SOCKET=\/run\/codex-tg\/action\/action\.sock/)
  assert.match(bridge, /BRIDGE_WAKE_SOCKET=\/run\/codex-tg\/wake\/wake\.sock/)
})

test('holds the app service in startup until its socket is shared with the bridge group', async () => {
  const app = await file('codex-tg-app.service')

  assert.match(
    app,
    /^ExecStartPost=\/opt\/tg-engage\/bridge\/deploy\/prepare-app-socket\.sh \/run\/codex-tg\/app\/app\.sock codex-tg$/m,
  )
})

test('socket preparation waits for a 0600 Unix socket then applies group-only access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-tg-socket-'))
  const socketPath = join(directory, 'app.sock')
  const targetGid = process.getgroups().find((gid) => gid !== process.getgid()) ?? process.getgid()
  const server = createServer()
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })

  const preparation = execFileAsync(
    fileURLToPath(new URL('../deploy/prepare-app-socket.sh', import.meta.url)),
    [socketPath, String(targetGid)],
    {
      env: {
        ...process.env,
        SOCKET_WAIT_ATTEMPTS: '50',
        SOCKET_WAIT_INTERVAL: '0.02',
      },
    },
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  const previousUmask = process.umask(0o177)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
  } finally {
    process.umask(previousUmask)
  }

  const original = await stat(socketPath)
  assert.equal(original.mode & 0o777, 0o600)
  if (targetGid !== process.getgid()) {
    assert.notEqual(original.gid, targetGid)
  }
  await preparation

  const prepared = await stat(socketPath)
  assert.equal(prepared.isSocket(), true)
  assert.equal(prepared.gid, targetGid)
  assert.equal(prepared.mode & 0o777, 0o660)
})

test('keeps the Codex export surface read-only to the token-holding bridge', async () => {
  const tmpfiles = await file('tmpfiles.conf')
  const bridge = await file('codex-tg-bridge.service')

  assert.match(tmpfiles, /d \/srv\/codex-workspace\/exports 2750 codexbot codex-tg/)
  assert.match(bridge, /^ReadOnlyPaths=.*\/srv\/codex-workspace\/exports$/m)
  assert.doesNotMatch(bridge, /^ReadWritePaths=.*\/srv\/codex-workspace\/exports/m)
})

test('hardens both system services and pins absolute executable paths', async () => {
  for (const name of ['codex-tg-app.service', 'codex-tg-bridge.service']) {
    const unit = await file(name)
    assert.match(unit, /^ProtectSystem=strict$/m)
    assert.match(unit, /^PrivateTmp=true$/m)
    assert.match(unit, /^NoNewPrivileges=true$/m)
    assert.match(unit, /^ExecStart=\//m)
    assert.doesNotMatch(unit, /<[^>]+>|^ExecStart=(?:node|codex)\b/m)
  }
})

test('installer verifies Node, Codex, swap, and schema before enabling services', async () => {
  const install = await file('install.sh')
  assert.match(install, /\/usr\/bin\/node --version/)
  assert.match(install, /\/usr\/local\/bin\/codex --version/)
  assert.match(
    install,
    /\/usr\/bin\/systemd-analyze verify[\s\\]+\/etc\/systemd\/system\/codex-tg-app\.service[\s\\]+\/etc\/systemd\/system\/codex-tg-bridge\.service/,
  )
  assert.match(install, /SwapTotal/)
  assert.match(install, /generate-json-schema/)
  assert.match(install, /capture-codex-contract\.mjs/)
  assert.doesNotMatch(install, /TELEGRAM_BOT_TOKEN=/)
})
