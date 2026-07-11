#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ConnectorSupervisor, createChannelStatusWriter } from './connector-supervisor.mjs'

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

export async function main(argv = process.argv.slice(2), env = process.env) {
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

  const appServer = spawn(codexPath, ['app-server', '--listen', `unix://${socketPath}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env,
    detached: true,
  })
  const connectorController = new AbortController()
  let connectorRun = null
  let tui = null
  try {
    await waitForSocket(socketPath, appServer)
    const writeChannelStatus = createChannelStatusWriter(resolve(
      bridgeRoot,
      local.statusPath ?? '.state/channel-status.json',
    ))
    const supervisor = new ConnectorSupervisor({
      command: nodePath,
      args: [join(bridgeRoot, 'src', 'local-connector-index.mjs')],
      env: {
        ...env,
        BRIDGE_SESSION_LABEL: local.sessionLabel,
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
            : '/opt/tg-engage/bridge/src/relay-stdio.mjs'),
        BRIDGE_RELAY_DB_PATH: local.relayDbPath ?? '/var/lib/codex-tg-bridge/bridge.sqlite3',
        CODEX_APPROVAL_POLICY: local.approvalPolicy ?? 'on-request',
        CODEX_SANDBOX_MODE: local.sandboxMode ?? 'workspace-write',
      },
      statusWriter: status => writeChannelStatus({
        ...status,
        sessionLabel: local.sessionLabel,
        codexSessionId: sessionId,
      }),
      reconnectInitialMs: local.reconnectInitialMs ?? 1_000,
      reconnectMaxMs: local.reconnectMaxMs ?? 20_000,
    })
    connectorRun = supervisor.run({ signal: connectorController.signal })

    tui = spawn(codexPath, ['resume', '--remote', `unix://${socketPath}`, sessionId], {
      stdio: 'inherit',
      env,
    })
    const result = await childExit(tui)
    if (result.code !== 0 && result.signal === null) process.exitCode = result.code
  } finally {
    connectorController.abort()
    if (appServer.exitCode === null) appServer.kill('SIGTERM')
    await Promise.allSettled([connectorRun, childExit(appServer)].filter(Boolean))
    await rm(runtimeDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
