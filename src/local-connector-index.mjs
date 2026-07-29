#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppServerClient } from './app-server-client.mjs'
import { AttachmentStore } from './attachment-store.mjs'
import { loadLocalConnectorConfig } from './config.mjs'
import { CommandInterruptFanout } from './interrupt-fanout.mjs'
import { LocalSessionConnector } from './local-session-connector.mjs'
import { TaskqMessageAdmission } from './message-admission.mjs'
import { TaskqContextResolver } from './task-context-resolver.mjs'
import { isMainModule } from './main-module.mjs'
import { ProcessRelayClient } from './process-relay-client.mjs'
import { RELAY_JOB_TTL_MS } from './relay-dispatcher.mjs'

const bridgeRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export async function loadConnectorEnv(env = process.env) {
  const taskqValues = [env.TASKQ_CLI_PATH, env.TASKQ_DB_PATH, env.TASKQ_AGENT_ID]
  const fanoutValues = [env.BRIDGE_INTERRUPT_FANOUT_COMMAND, env.BRIDGE_STOP_FLAG_PATH]
  if (taskqValues.some(Boolean) && fanoutValues.some(Boolean)) return env

  const configPath = env.BRIDGE_LOCAL_CONFIG
    ? resolve(env.BRIDGE_LOCAL_CONFIG)
    : join(bridgeRoot, '.state', 'local-channel.json')
  let local
  try {
    local = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return env
    throw error
  }
  const loaded = { ...env }
  if (!taskqValues.some(Boolean) && local.taskAdmission) {
    loaded.TASKQ_CLI_PATH = local.taskAdmission.cliPath
    loaded.TASKQ_DB_PATH = local.taskAdmission.dbPath
    loaded.TASKQ_AGENT_ID = local.taskAdmission.agentId
  }
  if (!fanoutValues.some(Boolean) && local.interruptFanout) {
    loaded.BRIDGE_INTERRUPT_FANOUT_COMMAND = local.interruptFanout.command
    loaded.BRIDGE_STOP_FLAG_PATH = local.interruptFanout.stopFlagPath
  }
  return loaded
}

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
  const connectorEnv = await loadConnectorEnv(env)
  const config = loadLocalConnectorConfig(connectorEnv)
  const contract = JSON.parse(await readFile(config.contractPath, 'utf8'))
  const appServerClient = await AppServerClient.connect({
    socketPath: config.appServerSocket,
    contract,
  })
  const relayProcess = buildRelayProcessSpec(config, connectorEnv)
  const relayClient = new ProcessRelayClient({
    ...relayProcess,
    frameMaxBytes: config.frameMaxBytes,
    closeGraceMs: config.relayCloseGraceMs,
  })
  const attachmentStore = await AttachmentStore.open({ root: config.localAttachmentRoot })
  const executionAdmission = config.taskAdmission
    ? new TaskqMessageAdmission(config.taskAdmission)
    : null
  const taskContextResolver = config.taskAdmission
    ? new TaskqContextResolver(config.taskAdmission)
    : null
  const interruptFanout = config.interruptFanout
    ? new CommandInterruptFanout({
        ...config.interruptFanout,
        timeoutMs: config.relayCloseGraceMs,
      })
    : null
  await attachmentStore.pruneOlderThan(Date.now() - RELAY_JOB_TTL_MS)
  const connector = new LocalSessionConnector({
    appServerClient,
    relayClient,
    sessionLabel: config.sessionLabel,
    connectorId: `local-${randomUUID()}`,
    codexSessionId: config.codexSessionId,
    threadId: config.threadId,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    closeGraceMs: config.relayCloseGraceMs,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: config.sandboxPolicy,
    ownerUserId: config.ownerUserId,
    privateChatIds: config.privateChatIds,
    repairChatIds: config.repairChatIds,
    attachmentStore,
    executionAdmission,
    interruptFanout,
    taskContextResolver,
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
    connector.on('deliveryReceipt', receipt => {
      console.log(JSON.stringify({
        level: receipt.status === 'sent' ? 'info' : 'error',
        event: 'local_connector_delivery',
        receipt,
      }))
    })
    connector.on('legacyOutput', output => {
      console.log(JSON.stringify({
        level: 'warn',
        event: 'local_connector_legacy_output',
        ...output,
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
