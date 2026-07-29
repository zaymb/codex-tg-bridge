import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskqMessageAdmission } from '../src/message-admission.mjs'

test('claims the shared Telegram source through taskq', async () => {
  const calls = []
  const controller = new AbortController()
  const admission = new TaskqMessageAdmission({
    cliPath: '/opt/taskq/taskq.py',
    dbPath: '/var/lib/taskq/tasks.sqlite3',
    agentId: 'elio',
    execFileImpl: async (path, args, options) => {
      calls.push({ path, args, options })
      return {
        stdout: JSON.stringify({
          source: 'telegram:-100123:77',
          owner: 'elio',
          acquired: true,
          fresh: true,
        }),
      }
    },
  })

  assert.equal(await admission.claim(
    { conversationKey: '-100123', messageId: '77' },
    { signal: controller.signal },
  ), true)
  assert.deepEqual(calls, [{
    path: '/opt/taskq/taskq.py',
    args: [
      '--db', '/var/lib/taskq/tasks.sqlite3',
      '--json', 'admit',
      '--source', 'telegram:-100123:77',
      '--by', 'elio',
      '--retention-seconds', '86400',
    ],
    options: {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      signal: controller.signal,
    },
  }])
})

test('fails closed when taskq denies or returns malformed output', async () => {
  const denied = new TaskqMessageAdmission({
    cliPath: '/opt/taskq/taskq.py',
    dbPath: '/var/lib/taskq/tasks.sqlite3',
    agentId: 'elio',
    execFileImpl: async () => ({ stdout: '{"owner":"laurie","acquired":false}' }),
  })
  assert.equal(await denied.claim({ conversationKey: '-100123', messageId: '77' }), false)

  const malformed = new TaskqMessageAdmission({
    cliPath: '/opt/taskq/taskq.py',
    dbPath: '/var/lib/taskq/tasks.sqlite3',
    agentId: 'elio',
    execFileImpl: async () => ({ stdout: 'not json' }),
  })
  await assert.rejects(
    malformed.claim({ conversationKey: '-100123', messageId: '77' }),
    /invalid JSON/,
  )
})
