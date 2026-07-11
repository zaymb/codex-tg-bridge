#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { AppServerClient } from './app-server-client.mjs'
import { loadLocalConnectorConfig } from './config.mjs'
import { LocalSessionConnector } from './local-session-connector.mjs'
import { ProcessRelayClient } from './process-relay-client.mjs'

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
    `BRIDGE_SESSION_LABEL=${config.sessionLabel}`,
    config.remoteNodePath,
    config.remoteScriptPath,
  ]
}

export async function main(env = process.env) {
  const config = loadLocalConnectorConfig(env)
  const contract = JSON.parse(await readFile(config.contractPath, 'utf8'))
  const appServerClient = await AppServerClient.connect({
    socketPath: config.appServerSocket,
    contract,
  })
  const relayClient = new ProcessRelayClient({
    command: config.sshPath,
    args: buildRelaySshArgs(config),
    frameMaxBytes: config.frameMaxBytes,
  })
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
  try {
    connector.on('relayStatus', status => {
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
      controller.signal.addEventListener('abort', resolve, { once: true })
    })
    await Promise.race([aborted, failure])
  } finally {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    await connector.close()
    await appServerClient.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'local_connector_fatal',
      error: { name: error.name, message: error.message },
    }))
    process.exitCode = 1
  }
}
