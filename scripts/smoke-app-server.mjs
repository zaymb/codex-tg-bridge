#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { AppServerClient } from '../src/app-server-client.mjs'
import { CodexRunner } from '../src/codex-runner.mjs'
import { StateStore } from '../src/state-store.mjs'

const execFile = promisify(execFileCallback)
const bridgeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const contractPath = process.env.CODEX_CONTRACT_PATH
  ?? join(bridgeRoot, 'fixtures/codex-app-server-0.143.0/contract.json')
const codexBin = process.env.CODEX_BIN ?? 'codex'
const workdir = process.env.CODEX_SMOKE_WORKDIR ?? resolve(bridgeRoot, '..')

async function waitForSocket(path, child, logs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app-server exited early: ${logs.value.slice(-4000)}`)
    try {
      const metadata = await stat(path)
      if (metadata.isSocket()) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for app-server socket: ${logs.value.slice(-4000)}`)
}

function waitForNotification(client, event, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const onEvent = params => {
      if (!predicate(params)) return
      cleanup()
      resolve(params)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${event}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      client.off(event, onEvent)
    }
    timer.unref?.()
    client.on(event, onEvent)
  })
}

async function stopChildGroup(child, timeoutMs = 5_000) {
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    return
  }
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      if (error.code === 'EPERM') return true
      throw error
    }
  }
  const signal = name => {
    try {
      process.kill(-child.pid, name)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const waitForGroupExit = async waitMs => {
    const deadline = Date.now() + waitMs
    while (groupExists() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return !groupExists()
  }
  if (!groupExists()) return
  signal('SIGTERM')
  if (await waitForGroupExit(timeoutMs)) return
  signal('SIGKILL')
  if (!await waitForGroupExit(1_000)) throw new Error(`Codex process group ${child.pid} did not exit`)
}

const contract = JSON.parse(await readFile(contractPath, 'utf8'))
const { stdout: versionOutput } = await execFile(codexBin, ['--version'])
const installedVersion = versionOutput.trim()
if (installedVersion !== contract.codexVersion) {
  throw new Error(`contract version mismatch: fixture=${contract.codexVersion}, installed=${installedVersion}`)
}

const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-real-smoke-'))
const socketPath = join(dir, 'app.sock')
const childEnv = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (key.startsWith('TELEGRAM_') || key.startsWith('BRIDGE_')) delete childEnv[key]
}
const child = spawn(codexBin, ['app-server', '--listen', `unix://${socketPath}`], {
  cwd: workdir,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})
const logs = { value: '' }
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', data => {
    logs.value = `${logs.value}${data.toString()}`.slice(-20_000)
  })
}

let client
const state = StateStore.open(':memory:')
try {
  await waitForSocket(socketPath, child, logs)
  client = await AppServerClient.connect({ socketPath, contract, requestTimeoutMs: 30_000 })
  const runner = new CodexRunner({
    client,
    stateStore: state,
    config: {
      codexWorkdir: workdir,
      codexWritableRoots: [],
      model: process.env.CODEX_SMOKE_MODEL || null,
      effort: process.env.CODEX_SMOKE_EFFORT || 'low',
      turnTimeoutMs: 120_000,
    },
  })
  const result = await runner.runTurn({
    conversationKey: 'local-smoke',
    ownerDm: false,
    text: 'This is a transport smoke test. Return action=send, text exactly TG_BRIDGE_SMOKE_OK, and a short reason. Do not use tools.',
    telegramContext: { eventType: 'local_smoke' },
    clientUserMessageId: 'local-smoke-1',
  })
  if (result.skipped || result.finalText !== 'TG_BRIDGE_SMOKE_OK') {
    throw new Error(`unexpected smoke result: ${JSON.stringify(result)}`)
  }
  let interruptedTurnId = null
  const interruptedStarted = waitForNotification(
    client,
    'notification:turn/started',
    params => params.threadId === result.threadId,
  )
  const interruptedCompletion = waitForNotification(
    client,
    'notification:turn/completed',
    params => params.threadId === result.threadId && params.turn?.id === interruptedTurnId,
  )
  const longTurn = await client.request('turn/start', {
    threadId: result.threadId,
    input: [{
      type: 'text',
      text: 'Run the shell command sleep 30, then reply. This turn will be interrupted by the transport smoke test.',
    }],
    cwd: workdir,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  interruptedTurnId = longTurn.turn.id
  const started = await interruptedStarted
  if (started.turn?.id !== interruptedTurnId) {
    throw new Error(`turn/start returned ${interruptedTurnId} but turn/started announced ${started.turn?.id}`)
  }
  await client.request('turn/interrupt', { threadId: result.threadId, turnId: interruptedTurnId })
  const interrupted = await interruptedCompletion
  if (interrupted.turn.status !== 'interrupted') {
    throw new Error(`interrupt smoke ended with ${interrupted.turn.status}`)
  }
  console.log(JSON.stringify({
    ok: true,
    codexVersion: installedVersion,
    threadId: result.threadId,
    turnId: result.turnId,
    finalText: result.finalText,
    interruptedTurnId,
    interruptedStatus: interrupted.turn.status,
  }))
} finally {
  await client?.close().catch(() => {})
  state.close()
  await stopChildGroup(child)
}
