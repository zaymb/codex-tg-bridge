import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { ProcessRelayClient } from '../src/process-relay-client.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => child.emit('exit', 0, 'SIGTERM')
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
  t.after(() => client.close())
  const frames = []
  client.on('frame', frame => frames.push(frame))

  const connecting = client.connect({ version: 1, type: 'hello', sessionLabel: 'tg-engage' })
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'ready' })}\n`)
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
  })
  assert.equal(frames.at(-1).job.jobId, 'telegram:1')
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
    const connecting = client.connect({ version: 1, type: 'hello' })
    child.stdout.write(line)
    await assert.rejects(connecting, /relay|JSON|size/i)
    await client.close()
  }
})
