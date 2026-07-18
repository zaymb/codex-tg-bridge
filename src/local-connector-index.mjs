#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { AppServerClient } from './app-server-client.mjs'
import { AttachmentStore } from './attachment-store.mjs'
import { loadLocalConnectorConfig } from './config.mjs'
import { LocalSessionConnector } from './local-session-connector.mjs'
import { isMainModule } from './main-module.mjs'
import { ProcessRelayClient } from './process-relay-client.mjs'
import { RELAY_JOB_TTL_MS } from './relay-dispatcher.mjs'

export function buildRelaySshArgs(config) {
  return [
    '-T',
    '-i', config.sshIdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'RequestTTY=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    `${config.sshUser}@${config.sshHost}`,
    'sudo', '-n', '-u', config.remoteServiceUser,
    'env',
    `BRIDGE_DB_PATH=${config.remoteDbPath}`,
    `BRIDGE_ATTACHMENT_ROOT=${config.relayAttachmentRoot}`,
    `BRIDGE_SESSION_LABEL=${config.sessionLabel}`,
    `BRIDGE_RELAY_FRAME_MAX_BYTES=${config.frameMaxBytes}`,
    `BRIDGE_RELAY_COALESCE_QUIET_MS=${config.coalesceQuietMs}`,
    `BRIDGE_RELAY_COALESCE_MAX_MS=${config.coalesceMaxMs}`,
    config.remoteNodePath,
    config.remoteScriptPath,
  ]
}

export function buildRelayProcessSpec(config, env = process.env) {
  if (config.relayMode === 'local') {
    return {
      command: config.localNodePath,
      args: [config.localScriptPath],
      env: {
        ...env,
        BRIDGE_DB_PATH: config.localDbPath,
        BRIDGE_ATTACHMENT_ROOT: config.relayAttachmentRoot,
        BRIDGE_SESSION_LABEL: config.sessionLabel,
        BRIDGE_RELAY_FRAME_MAX_BYTES: String(config.frameMaxBytes),
        BRIDGE_RELAY_COALESCE_QUIET_MS: String(config.coalesceQuietMs),
        BRIDGE_RELAY_COALESCE_MAX_MS: String(config.coalesceMaxMs),
      },
    }
  }
  return {
    command: config.sshPath,
    args: buildRelaySshArgs(config),
    env,
  }
}

export async function main(env = process.env) {
  const config = loadLocalConnectorConfig(env)
  const contract = JSON.parse(await readFile(config.contractPath, 'utf8'))
  const appServerClient = await AppServerClient.connect({
    socketPath: config.appServerSocket,
    contract,
  })
  const relayProcess = buildRelayProcessSpec(config, env)
  const relayClient = new ProcessRelayClient({
    ...relayProcess,
    frameMaxBytes: config.frameMaxBytes,
    closeGraceMs: config.relayCloseGraceMs,
  })
  const attachmentStore = await AttachmentStore.open({ root: config.localAttachmentRoot })
  await attachmentStore.pruneOlderThan(Date.now() - RELAY_JOB_TTL_MS)
  const connector = new LocalSessionConnector({
    appServerClient,
    relayClient,
    sessionLabel: config.sessionLabel,
    connectorId: `local-${randomUUID()}`,
    codexSessionId: config.codexSessionId,
    threadId: config.threadId,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: config.sandboxPolicy,
    ownerUserId: config.ownerUserId,
    privateChatIds: config.privateChatIds,
    repairChatIds: config.repairChatIds,
    attachmentStore,
  })
  const controller = new AbortController()
  const shutdown = () => controller.abort()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const failure = new Promise((resolve, reject) => {
    const fail = error => reject(error)
    connector.once('error', fail)
    relayClient.once('error', fail)
    appServerClient.once('close', fail)
    appServerClient.once('protocolError', fail)
  })
  let resolveDisengaged
  const disengaged = new Promise(resolve => { resolveDisengaged = resolve })
  let outcome = { disengaged: false }
  try {
    connector.on('relayStatus', status => {
      if (status.status === 'disengaged') {
        console.log(JSON.stringify({
          level: 'info',
          event: 'local_connector_disengaged',
          remoteNowMs: status.remoteNowMs ?? null,
        }))
        resolveDisengaged({ disengaged: true })
        return
      }
      console.log(JSON.stringify({
        level: 'info',
        event: 'local_connector_heartbeat',
        remoteNowMs: status.remoteNowMs ?? null,
      }))
    })
    await Promise.race([connector.start(), failure])
    console.log(JSON.stringify({
      level: 'info',
      event: 'local_connector_ready',
      sessionLabel: config.sessionLabel,
    }))
    const aborted = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ disengaged: false }), { once: true })
    })
    outcome = await Promise.race([aborted, failure, disengaged])
  } finally {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    await connector.close()
    await appServerClient.close()
  }
  return outcome
}

if (isMainModule(import.meta.url)) {
  try {
    const outcome = await main()
    if (outcome.disengaged) process.exitCode = 78
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'local_connector_fatal',
      error: { name: error.name, message: error.message },
    }))
    process.exitCode = 1
  }
}
