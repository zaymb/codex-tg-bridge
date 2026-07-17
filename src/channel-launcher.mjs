#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConnectorSupervisor, createChannelStatusWriter } from './connector-supervisor.mjs'
import { isMainModule } from './main-module.mjs'

const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function wait(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

async function waitForSocket(socketPath, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Codex app-server exited with code ${child.exitCode}`)
    try {
      if ((await stat(socketPath)).isSocket()) return
    } catch {}
    await wait(50)
  }
  throw new Error('timed out waiting for Codex app-server socket')
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function signalDetachedProcessGroup(child, signal) {
  if (!child?.pid) return false
  if (process.platform === 'win32') return child.kill(signal)
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(processGroupId) && Date.now() < deadline) await wait(20)
  return !processGroupExists(processGroupId)
}

async function stopDetachedProcessGroup(child, graceMs) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await childExit(child)
    return
  }
  signalDetachedProcessGroup(child, 'SIGTERM')
  if (!await waitForProcessGroupExit(child.pid, graceMs)) {
    signalDetachedProcessGroup(child, 'SIGKILL')
    if (!await waitForProcessGroupExit(child.pid, graceMs)) {
      throw new Error('Codex app-server process group did not exit')
    }
  }
  await childExit(child)
}

export async function waitForChannelExit(tui, connectorRun) {
  const outcome = await Promise.race([
    childExit(tui).then(result => ({ source: 'tui', result })),
    connectorRun.then(() => ({ source: 'connector' })),
  ])
  if (outcome.source === 'connector') {
    throw new Error('connector supervisor stopped unexpectedly')
  }
  return outcome.result
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { signal } = {},
) {
  const sessionId = argv[0]
  if (!sessionId || !/^[A-Za-z0-9-]+$/u.test(sessionId)) {
    throw new Error('usage: npm run channel -- <codex-session-id>')
  }
  const configPath = env.BRIDGE_LOCAL_CONFIG
    ? resolve(env.BRIDGE_LOCAL_CONFIG)
    : join(bridgeRoot, '.state', 'local-channel.json')
  const local = JSON.parse(await readFile(configPath, 'utf8'))
  const runtimeDir = await mkdtemp(join(tmpdir(), 'codex-tg-channel-'))
  const socketPath = join(runtimeDir, 'app.sock')
  const codexPath = local.codexPath
  const nodePath = local.nodePath ?? process.execPath
  const contractPath = resolve(bridgeRoot, local.contractPath ?? 'fixtures/codex-app-server-0.144.1/contract.json')
  const appServerShutdownGraceMs = local.appServerShutdownGraceMs ?? 2_000
  if (!Number.isSafeInteger(appServerShutdownGraceMs) || appServerShutdownGraceMs < 0) {
    throw new Error('appServerShutdownGraceMs must be a non-negative integer')
  }
  const writeChannelStatus = createChannelStatusWriter(resolve(
    bridgeRoot,
    local.statusPath ?? '.state/channel-status.json',
  ))
  const writeStatus = status => writeChannelStatus({
    ...status,
    sessionLabel: local.sessionLabel,
    codexSessionId: sessionId,
    launcherPid: process.pid,
  })

  const appServer = spawn(codexPath, ['app-server', '--listen', `unix://${socketPath}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env,
    detached: true,
  })
  const connectorController = new AbortController()
  let connectorRun = null
  let tui = null
  let stopReason = 'launcher_failure'
  const shutdown = () => {
    connectorController.abort()
    if (tui?.exitCode === null && tui.signalCode === null) tui.kill('SIGTERM')
    signalDetachedProcessGroup(appServer, 'SIGTERM')
  }
  signal?.addEventListener('abort', shutdown, { once: true })
  if (signal?.aborted) shutdown()
  try {
    await writeStatus({
      source: 'telegram',
      status: 'starting',
      updatedAtMs: Date.now(),
    })
    await waitForSocket(socketPath, appServer)
    if (signal?.aborted) return
    const supervisor = new ConnectorSupervisor({
      command: nodePath,
      args: [join(bridgeRoot, 'src', 'local-connector-index.mjs')],
      env: {
        ...env,
        BRIDGE_SESSION_LABEL: local.sessionLabel,
        TELEGRAM_OWNER_USER_ID: String(local.ownerUserId),
        TELEGRAM_PRIVATE_CHAT_IDS: (local.privateChatIds ?? []).join(','),
        TELEGRAM_REPAIR_CHAT_IDS: (local.repairChatIds ?? []).join(','),
        CODEX_SESSION_ID: sessionId,
        CODEX_THREAD_ID: sessionId,
        APP_SERVER_SOCKET: socketPath,
        CODEX_CONTRACT_PATH: contractPath,
        BRIDGE_RELAY_MODE: local.relayMode ?? 'ssh',
        BRIDGE_SSH_PATH: local.sshPath ?? '/usr/bin/ssh',
        BRIDGE_RELAY_HOST: local.relayHost,
        BRIDGE_RELAY_SSH_USER: local.relaySshUser,
        BRIDGE_RELAY_IDENTITY_FILE: local.relayIdentityFile,
        BRIDGE_RELAY_SERVICE_USER: local.relayServiceUser ?? 'tgbridge',
        BRIDGE_RELAY_NODE_PATH: local.relayNodePath ?? (local.relayMode === 'local' ? nodePath : '/usr/local/bin/node'),
        BRIDGE_RELAY_SCRIPT_PATH: local.relayScriptPath
          ?? (local.relayMode === 'local'
            ? join(bridgeRoot, 'src', 'relay-stdio.mjs')
            : '/opt/codex-tg-bridge/src/relay-stdio.mjs'),
        BRIDGE_RELAY_DB_PATH: local.relayDbPath ?? '/var/lib/codex-tg-bridge/bridge.sqlite3',
        BRIDGE_RELAY_ATTACHMENT_ROOT: local.relayAttachmentRoot ?? '/var/lib/codex-tg-bridge/attachments',
        CODEX_APPROVAL_POLICY: local.approvalPolicy ?? 'on-request',
        CODEX_SANDBOX_MODE: local.sandboxMode ?? 'workspace-write',
      },
      statusWriter: writeStatus,
      reconnectInitialMs: local.reconnectInitialMs ?? 1_000,
      reconnectMaxMs: local.reconnectMaxMs ?? 20_000,
      heartbeatTimeoutMs: local.heartbeatTimeoutMs ?? 20_000,
    })
    connectorRun = supervisor.run({ signal: connectorController.signal })

    tui = spawn(codexPath, ['resume', '--remote', `unix://${socketPath}`, sessionId], {
      stdio: 'inherit',
      env,
    })
    const result = await waitForChannelExit(tui, connectorRun)
    stopReason = 'tui_exited'
    if (result.code !== 0 && result.signal === null) process.exitCode = result.code
  } catch (error) {
    if (!signal?.aborted) throw error
    stopReason = 'launcher_shutdown'
  } finally {
    signal?.removeEventListener('abort', shutdown)
    connectorController.abort()
    if (tui?.exitCode === null && tui.signalCode === null) tui.kill('SIGTERM')
    await Promise.allSettled([
      connectorRun,
      tui && childExit(tui),
    ].filter(Boolean))
    await stopDetachedProcessGroup(appServer, appServerShutdownGraceMs)
    await rm(runtimeDir, { recursive: true, force: true })
    await writeStatus({
      source: 'telegram',
      status: 'stopped',
      updatedAtMs: Date.now(),
      reason: signal?.aborted ? 'launcher_shutdown' : stopReason,
    })
  }
}

export async function runCli(
  argv = process.argv.slice(2),
  env = process.env,
  processRef = process,
) {
  const controller = new AbortController()
  const shutdown = signal => controller.abort(signal)
  const handlers = new Map([
    ['SIGHUP', () => shutdown('SIGHUP')],
    ['SIGINT', () => shutdown('SIGINT')],
    ['SIGTERM', () => shutdown('SIGTERM')],
  ])
  for (const [signal, handler] of handlers) processRef.once(signal, handler)
  try {
    await main(argv, env, { signal: controller.signal })
  } finally {
    for (const [signal, handler] of handlers) processRef.off(signal, handler)
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
