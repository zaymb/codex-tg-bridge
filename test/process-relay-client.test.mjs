import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { ProcessRelayClient } from '../src/process-relay-client.mjs'

function fakeChild({ ignoreSigterm = false } = {}) {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = signal => {
    child.signals.push(signal)
    if (ignoreSigterm && signal === 'SIGTERM') return true
    child.signalCode = signal
    child.emit('exit', null, signal)
    return true
  }
  return child
}

test('starts the relay command, completes hello, and parses frames', async t => {
  const child = fakeChild()
  const spawned = []
  const writes = []
  child.stdin.on('data', chunk => writes.push(chunk.toString()))
  const client = new ProcessRelayClient({
    command: 'ssh',
    args: ['relay-host', 'relay-command'],
    env: { BRIDGE_DB_PATH: '/tmp/bridge.sqlite3' },
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options })
      return child
    },
    connectTimeoutMs: 1_000,
  })
  const frames = []
  client.on('frame', frame => frames.push(frame))
  t.after(() => client.close())

  const connecting = client.connect({
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    runtimeFingerprint: 'runtime-a',
  })
  child.stdout.write(`${JSON.stringify({
    version: 1,
    type: 'ready',
    runtimeFingerprint: 'runtime-a',
  })}\n`)
  await connecting
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'job', job: { jobId: 'telegram:1' } })}\n`)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(spawned[0].command, 'ssh')
  assert.deepEqual(spawned[0].args, ['relay-host', 'relay-command'])
  assert.deepEqual(spawned[0].options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(spawned[0].options.detached, true)
  assert.equal(spawned[0].options.env.TERM, 'dumb')
  assert.equal(spawned[0].options.env.BRIDGE_DB_PATH, '/tmp/bridge.sqlite3')
  assert.deepEqual(JSON.parse(writes.join('').trim()), {
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    runtimeFingerprint: 'runtime-a',
  })
  assert.equal(frames.at(-1).job.jobId, 'telegram:1')
})

test('fails closed when the remote relay reports a different runtime fingerprint', async () => {
  const child = fakeChild()
  const client = new ProcessRelayClient({
    command: 'ssh',
    args: [],
    spawnImpl: () => child,
    connectTimeoutMs: 1_000,
  })
  const frames = []
  client.on('frame', frame => frames.push(frame))
  const connecting = client.connect({
    version: 1,
    type: 'hello',
    runtimeFingerprint: 'runtime-a',
  })
  child.stdout.write(`${JSON.stringify({
    version: 1,
    type: 'ready',
    runtimeFingerprint: 'runtime-b',
  })}\n`)

  await assert.rejects(connecting, /runtime fingerprint mismatch/i)
  assert.deepEqual(frames, [])
  await client.close()
})

test('fails closed on malformed or oversized relay output', async () => {
  for (const line of ['not-json\n', `${'x'.repeat(33)}\n`]) {
    const child = fakeChild()
    const client = new ProcessRelayClient({
      command: 'ssh',
      args: [],
      spawnImpl: () => child,
      frameMaxBytes: 32,
      connectTimeoutMs: 1_000,
    })
    const connecting = client.connect({ version: 1, type: 'hello', runtimeFingerprint: 'runtime-a' })
    child.stdout.write(line)
    await assert.rejects(connecting, /relay|JSON|size/i)
    await client.close()
  }
})

test('waits for relay exit and hard-kills a detached SSH process that ignores SIGTERM', async () => {
  const child = fakeChild({ ignoreSigterm: true })
  const client = new ProcessRelayClient({
    command: 'ssh',
    args: [],
    spawnImpl: () => child,
    connectTimeoutMs: 1_000,
    closeGraceMs: 5,
  })
  const connecting = client.connect({ version: 1, type: 'hello', runtimeFingerprint: 'runtime-a' })
  child.stdout.write(`${JSON.stringify({
    version: 1,
    type: 'ready',
    runtimeFingerprint: 'runtime-a',
  })}\n`)
  await connecting

  await client.close()

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(child.signalCode, 'SIGKILL')
})
