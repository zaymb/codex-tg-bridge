import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { bindCliSignals, waitForChannelExit } from '../src/channel-launcher.mjs'

const bridgeRoot = resolve(import.meta.dirname, '..')
const launcherPath = join(bridgeRoot, 'src', 'channel-launcher.mjs')
const sessionId = 'test-session-1234'

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function createFixture({ appServerShutdownGraceMs = 200 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tg-channel-launcher-'))
  const records = join(directory, 'records')
  const fakeCodexPath = join(directory, 'fake-codex.mjs')
  const statusPath = join(directory, 'channel-status.json')
  const configPath = join(directory, 'local-channel.json')
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [command, ...args] = process.argv.slice(2)
const records = process.env.FAKE_CODEX_RECORDS
await mkdir(records, { recursive: true })
const wait = () => new Promise(() => {})
setInterval(() => {}, 1_000)

if (command === 'app-server') {
  const socketPath = args.at(-1).replace(/^unix:\\/\\//u, '')
  const server = createServer(() => {})
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolveListen)
  })
  await writeFile(join(records, 'app-server.json'), JSON.stringify({ pid: process.pid, socketPath }))
  if (process.env.FAKE_ORPHAN_WORKER === '1') {
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: 'ignore',
    })
    await writeFile(join(records, 'worker.json'), JSON.stringify({ pid: worker.pid }))
  }
  const shutdown = () => server.close(() => process.exit(0))
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await wait()
} else if (command === 'resume') {
  await writeFile(join(records, 'tui.json'), JSON.stringify({ pid: process.pid }))
  const shutdown = () => process.exit(0)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  const exitMs = Number.parseInt(process.env.FAKE_TUI_EXIT_MS ?? '', 10)
  if (Number.isFinite(exitMs)) setTimeout(() => process.exit(0), exitMs)
  await wait()
} else {
  process.exit(2)
}
`)
  await chmod(fakeCodexPath, 0o700)
  await writeFile(configPath, `${JSON.stringify({
    sessionLabel: 'test-channel',
    ownerUserId: '1000000001',
    privateChatIds: ['1000000001'],
    repairChatIds: [],
    codexPath: fakeCodexPath,
    nodePath: process.execPath,
    contractPath: 'fixtures/codex-app-server-0.144.1/contract.json',
    relayHost: '127.0.0.1',
    relaySshUser: 'nobody',
    relayIdentityFile: join(directory, 'unused-key'),
    relayServiceUser: 'nobody',
    relayNodePath: process.execPath,
    relayScriptPath: join(directory, 'unused-relay.mjs'),
    relayDbPath: join(directory, 'unused.sqlite3'),
    statusPath,
    reconnectInitialMs: 5,
    reconnectMaxMs: 10,
    appServerShutdownGraceMs,
  }, null, 2)}\n`)

  return { configPath, records, statusPath }
}

function startLauncher(fixture, env = {}) {
  return spawn(process.execPath, [launcherPath, sessionId], {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      BRIDGE_LOCAL_CONFIG: fixture.configPath,
      FAKE_CODEX_RECORDS: fixture.records,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function readChannelChildren(records) {
  let appServer
  let tui
  await waitFor(async () => {
    try {
      appServer = JSON.parse(await readFile(join(records, 'app-server.json'), 'utf8'))
      tui = JSON.parse(await readFile(join(records, 'tui.json'), 'utf8'))
      return true
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  })
  return { appServer, tui }
}

async function readRecordedProcess(records, name) {
  let record
  await waitFor(async () => {
    try {
      record = JSON.parse(await readFile(join(records, `${name}.json`), 'utf8'))
      return true
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  })
  return record
}

async function cleanupChildren(launcher, children = {}) {
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  for (const child of Object.values(children)) {
    if (child?.pid && processExists(child.pid)) process.kill(child.pid, 'SIGKILL')
  }
}

test('an unexpected supervisor stop terminates the channel wait', async () => {
  const tui = new EventEmitter()
  tui.exitCode = null
  tui.signalCode = null
  await assert.rejects(
    waitForChannelExit(tui, Promise.resolve()),
    /connector supervisor stopped unexpectedly/u,
  )
})

test('SIGUSR1 requests a reconnect without shutting down the launcher', () => {
  const processRef = new EventEmitter()
  const controller = new AbortController()
  let engageCalls = 0
  const unbind = bindCliSignals(processRef, {
    shutdown: signal => controller.abort(signal),
    engage: () => { engageCalls += 1 },
  })

  processRef.emit('SIGUSR1')
  processRef.emit('SIGUSR1')
  assert.equal(engageCalls, 2)
  assert.equal(controller.signal.aborted, false)

  processRef.emit('SIGTERM')
  assert.equal(controller.signal.aborted, true)
  unbind()
  assert.equal(processRef.listenerCount('SIGUSR1'), 0)
})

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  test(`${signal} stops every channel child, removes the socket, and records stopped`, async () => {
    const fixture = await createFixture()
    const launcher = startLauncher(fixture)
    let stderr = ''
    launcher.stderr.on('data', chunk => { stderr += chunk })
    let children = {}
    try {
      children = await readChannelChildren(fixture.records)

      launcher.kill(signal)
      assert.deepEqual(await childExit(launcher), { code: 0, signal: null }, stderr)
      await waitFor(() => !processExists(children.appServer.pid) && !processExists(children.tui.pid))

      const status = JSON.parse(await readFile(fixture.statusPath, 'utf8'))
      assert.deepEqual(status, {
        source: 'telegram',
        status: 'stopped',
        updatedAtMs: status.updatedAtMs,
        reason: 'launcher_shutdown',
        sessionLabel: 'test-channel',
        codexSessionId: sessionId,
        launcherPid: launcher.pid,
      })
      await assert.rejects(stat(dirname(children.appServer.socketPath)), { code: 'ENOENT' })
    } finally {
      await cleanupChildren(launcher, children)
    }
  })
}

test('a normal TUI exit performs the same cleanup and records its reason', async () => {
  const fixture = await createFixture()
  const launcher = startLauncher(fixture, { FAKE_TUI_EXIT_MS: '50' })
  let children = {}
  try {
    children = await readChannelChildren(fixture.records)
    assert.deepEqual(await childExit(launcher), { code: 0, signal: null })
    await waitFor(() => !processExists(children.appServer.pid) && !processExists(children.tui.pid))

    const status = JSON.parse(await readFile(fixture.statusPath, 'utf8'))
    assert.equal(status.status, 'stopped')
    assert.equal(status.reason, 'tui_exited')
    assert.equal(status.codexSessionId, sessionId)
    await assert.rejects(stat(dirname(children.appServer.socketPath)), { code: 'ENOENT' })
  } finally {
    await cleanupChildren(launcher, children)
  }
})

test('kills the detached app-server process group when its wrapper leaves a worker behind', async () => {
  const fixture = await createFixture({ appServerShutdownGraceMs: 100 })
  const launcher = startLauncher(fixture, { FAKE_ORPHAN_WORKER: '1' })
  let stderr = ''
  launcher.stderr.on('data', chunk => { stderr += chunk })
  let children = {}
  try {
    children = await readChannelChildren(fixture.records)
    children.worker = await readRecordedProcess(fixture.records, 'worker')

    launcher.kill('SIGTERM')
    assert.deepEqual(await childExit(launcher), { code: 0, signal: null }, stderr)
    await waitFor(() => !processExists(children.appServer.pid) && !processExists(children.worker.pid))
  } finally {
    await cleanupChildren(launcher, children)
  }
})
