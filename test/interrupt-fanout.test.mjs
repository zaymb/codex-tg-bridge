import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CommandInterruptFanout } from '../src/interrupt-fanout.mjs'

test('runs an exact external control command without a shell', async () => {
  const calls = []
  const fanout = new CommandInterruptFanout({
    command: '/opt/local/interrupt-peer',
    stopFlagPath: '/tmp/absent-stop-flag',
    timeoutMs: 2_000,
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options })
      callback(null)
    },
  })

  await fanout.apply({
    action: 'stop',
    requestId: 'interrupt-7',
    conversationKey: '-100123:9',
    target: 'laurie',
  })

  assert.deepEqual(calls, [{
    command: '/opt/local/interrupt-peer',
    args: ['stop', 'interrupt-7', '-100123:9', 'laurie'],
    options: { timeout: 2_000, windowsHide: true },
  }])
})

test('rejects unsupported controls before spawning a process', async () => {
  let called = false
  const fanout = new CommandInterruptFanout({
    command: '/opt/local/interrupt-peer',
    stopFlagPath: '/tmp/absent-stop-flag',
    timeoutMs: 2_000,
    execFileImpl() { called = true },
  })

  assert.throws(
    () => fanout.apply({ action: 'pause', requestId: 'request-1', conversationKey: '42' }),
    /unsupported interrupt fanout action/u,
  )
  assert.equal(called, false)
})

test('rejects unsupported fanout targets before spawning a process', () => {
  let called = false
  const fanout = new CommandInterruptFanout({
    command: '/opt/local/interrupt-peer',
    stopFlagPath: '/tmp/absent-stop-flag',
    timeoutMs: 2_000,
    execFileImpl() { called = true },
  })

  assert.throws(
    () => fanout.apply({ action: 'stop', requestId: 'request-1', conversationKey: '42', target: 'gale' }),
    /unsupported interrupt fanout target/u,
  )
  assert.equal(called, false)
})

test('a Laurie-only latch does not pause Elio, while legacy and all-agent latches do', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interrupt-target-'))
  const stopFlagPath = join(directory, 'stop.flag')
  const fanout = new CommandInterruptFanout({
    command: '/opt/local/interrupt-peer',
    stopFlagPath,
    timeoutMs: 2_000,
  })

  assert.equal(fanout.isStopped(), false)
  await writeFile(stopFlagPath, 'target=laurie\n')
  assert.equal(fanout.isStopped(), false)
  await writeFile(stopFlagPath, 'target=all\n')
  assert.equal(fanout.isStopped(), true)
  await writeFile(stopFlagPath, '1720000000\n')
  assert.equal(fanout.isStopped(), true)
})
