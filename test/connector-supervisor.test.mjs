import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  ConnectorSupervisor,
  createChannelStatusWriter,
  createConnectorFailureWriter,
} from '../src/connector-supervisor.mjs'

function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = signal => {
    child.signalCode = signal
    child.emit('exit', null, signal)
    return true
  }
  child.exit = code => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  return child
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

test('isolates connector stdio from the TUI and restarts after relay disconnect', async () => {
  const children = []
  const spawns = []
  const statuses = []
  let now = 1_000
  const controller = new AbortController()
  const supervisor = new ConnectorSupervisor({
    command: '/usr/local/bin/node',
    args: ['/bridge/local-connector-index.mjs'],
    env: { TEST: '1' },
    spawnImpl(command, args, options) {
      const child = fakeChild(100 + children.length)
      children.push(child)
      spawns.push({ command, args, options })
      return child
    },
    statusWriter: status => statuses.push(status),
    clock: () => ++now,
    waitImpl: async () => {},
    reconnectInitialMs: 10,
    reconnectMaxMs: 40,
  })

  const running = supervisor.run({ signal: controller.signal })
  await waitFor(() => children.length === 1)
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(spawns[0].options.detached, true)

  children[0].stdout.write(`${JSON.stringify({ event: 'local_connector_ready' })}\n`)
  await waitFor(() => statuses.some(status => status.status === 'connected'))
  children[0].exit(1)
  await waitFor(() => children.length === 2)
  assert.ok(statuses.some(status => status.status === 'reconnecting' && status.nextRetryMs === 10))

  children[1].stdout.write(`${JSON.stringify({ event: 'local_connector_heartbeat' })}\n`)
  await waitFor(() => statuses.filter(status => status.status === 'connected').length >= 2)
  controller.abort()
  await running

  assert.equal(children[1].signalCode, 'SIGTERM')
  assert.equal(statuses.at(-1).status, 'stopped')
})

test('persists the latest Telegram delivery result across heartbeat status updates', async () => {
  const children = []
  const statuses = []
  const alerts = []
  const controller = new AbortController()
  const supervisor = new ConnectorSupervisor({
    command: '/usr/local/bin/node',
    spawnImpl() {
      const child = fakeChild(400 + children.length)
      children.push(child)
      return child
    },
    statusWriter: status => statuses.push(status),
    deliveryAlert: receipt => alerts.push(receipt),
    waitImpl: async () => {},
    heartbeatTimeoutMs: 1_000,
  })

  const running = supervisor.run({ signal: controller.signal })
  await waitFor(() => children.length === 1)
  children[0].stdout.write(`${JSON.stringify({
    event: 'local_connector_delivery',
    receipt: {
      receiptId: 'relay-delivery:batch-a',
      batchId: 'batch-a',
      status: 'failed',
      actions: [{ actionId: 'reply-a', status: 'failed', error: 'Telegram rejected the message' }],
    },
  })}\n`)
  children[0].stdout.write(`${JSON.stringify({ event: 'local_connector_heartbeat' })}\n`)

  await waitFor(() => statuses.some(status => status.lastDelivery?.batchId === 'batch-a'))
  const connected = statuses.filter(status => status.status === 'connected').at(-1)
  assert.equal(connected.lastDelivery.status, 'failed')
  assert.equal(connected.lastDelivery.actions[0].error, 'Telegram rejected the message')
  assert.deepEqual(alerts, [connected.lastDelivery])

  controller.abort()
  await running
})

test('writes an owner-only atomic channel status file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tg-channel-status-'))
  const path = join(directory, 'nested', 'status.json')
  const writeStatus = createChannelStatusWriter(path)

  await writeStatus({ source: 'telegram', status: 'connected', updatedAtMs: 123 })

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    source: 'telegram',
    status: 'connected',
    updatedAtMs: 123,
  })
  assert.equal((await stat(path)).mode & 0o077, 0)
})

test('persists a connector rejection reason and carries it across the retry status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tg-connector-failure-'))
  const failurePath = join(directory, 'nested', 'failures.jsonl')
  const children = []
  const statuses = []
  const controller = new AbortController()
  const supervisor = new ConnectorSupervisor({
    command: '/usr/local/bin/node',
    spawnImpl() {
      const child = fakeChild(500 + children.length)
      children.push(child)
      return child
    },
    statusWriter: status => statuses.push(status),
    failureWriter: createConnectorFailureWriter(failurePath),
    waitImpl: async () => {},
    reconnectInitialMs: 1,
  })

  const running = supervisor.run({ signal: controller.signal })
  await waitFor(() => children.length === 1)
  children[0].stderr.write('relay runtime fingerprint mismatch\n')
  await new Promise(resolve => setImmediate(resolve))
  children[0].exit(1)

  await waitFor(() => statuses.some(status => status.lastFailure))
  await waitFor(() => children.length === 2)
  const reconnecting = statuses.find(status => status.status === 'reconnecting'
    && status.lastFailure?.error.includes('fingerprint mismatch'))
  const nextAttempt = statuses.find(status => status.status === 'reconnecting'
    && status.attempt === 2
    && status.lastFailure?.error.includes('fingerprint mismatch'))
  assert.ok(reconnecting)
  assert.ok(nextAttempt)

  const records = (await readFile(failurePath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 1)
  assert.equal(records[0].exitCode, 1)
  assert.match(records[0].error, /fingerprint mismatch/u)
  assert.equal((await stat(failurePath)).mode & 0o077, 0)

  controller.abort()
  await running
})

test('marks a stale heartbeat disconnected and restarts the connector', async () => {
  const children = []
  const statuses = []
  const controller = new AbortController()
  const supervisor = new ConnectorSupervisor({
    command: '/usr/local/bin/node',
    spawnImpl() {
      const child = fakeChild(200 + children.length)
      children.push(child)
      return child
    },
    statusWriter: status => statuses.push(status),
    waitImpl: async () => {},
    reconnectInitialMs: 1,
    heartbeatTimeoutMs: 20,
  })

  const running = supervisor.run({ signal: controller.signal })
  await waitFor(() => children.length === 1)
  children[0].stdout.write(`${JSON.stringify({ event: 'local_connector_ready' })}\n`)
  await waitFor(() => statuses.some(status => status.status === 'connected'))
  await waitFor(() => children.length === 2)

  assert.equal(children[0].signalCode, 'SIGTERM')
  assert.ok(statuses.some(status => status.status === 'disconnected'
    && status.reason === 'heartbeat_timeout'))
  controller.abort()
  await running
})

test('holds a disengaged connector offline until an explicit engage', async () => {
  const children = []
  const statuses = []
  const controller = new AbortController()
  const supervisor = new ConnectorSupervisor({
    command: '/usr/local/bin/node',
    spawnImpl() {
      const child = fakeChild(300 + children.length)
      children.push(child)
      return child
    },
    statusWriter: status => statuses.push(status),
    waitImpl: async () => {},
    reconnectInitialMs: 1,
  })

  const running = supervisor.run({ signal: controller.signal })
  await waitFor(() => children.length === 1)
  children[0].stdout.write(`${JSON.stringify({ event: 'local_connector_disengaged' })}\n`)
  children[0].exit(78)
  await waitFor(() => statuses.some(status => status.status === 'disengaged'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(children.length, 1, 'disengage must not enter the reconnect loop')

  assert.equal(supervisor.engage(), true)
  await waitFor(() => children.length === 2)
  assert.equal(supervisor.engage(), false, 'engage only has meaning while held offline')

  controller.abort()
  await running
  assert.equal(children[1].signalCode, 'SIGTERM')
})
