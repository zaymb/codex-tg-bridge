import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskqContextResolver } from '../src/task-context-resolver.mjs'

test('opens matching task context through the shared taskq CLI', async () => {
  const calls = []
  const controller = new AbortController()
  const resolver = new TaskqContextResolver({
    cliPath: '/opt/taskq/taskq.py',
    dbPath: '/var/lib/taskq/tasks.sqlite3',
    agentId: 'elio',
    execFileImpl: async (path, args, options) => {
      calls.push({ path, args, options })
      return {
        stdout: JSON.stringify({
          status: 'opened',
          task: { id: 46, title: 'Body weather' },
          landing_context: { content: 'real landing' },
        }),
      }
    },
  })

  const result = await resolver.resolve(
    '身体天气还有上下文吗',
    { signal: controller.signal },
  )

  assert.equal(result.status, 'opened')
  assert.deepEqual(calls[0].path, '/opt/taskq/taskq.py')
  assert.deepEqual(calls[0].args, [
    '--db', '/var/lib/taskq/tasks.sqlite3',
    '--json', 'resolve',
    '--text', '身体天气还有上下文吗',
    '--by', 'elio',
  ])
  assert.equal(calls[0].options.maxBuffer, 2 * 1024 * 1024)
  assert.equal(calls[0].options.timeout, 10_000)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
  assert.equal(calls[0].options.signal, controller.signal)
})

test('rejects malformed resolver output and skips empty text', async () => {
  const resolver = new TaskqContextResolver({
    cliPath: '/opt/taskq/taskq.py',
    dbPath: '/var/lib/taskq/tasks.sqlite3',
    agentId: 'elio',
    execFileImpl: async () => ({ stdout: '{"status":"surprise"}' }),
  })

  assert.deepEqual(await resolver.resolve('  '), {
    status: 'none',
    candidates: [],
  })
  await assert.rejects(resolver.resolve('task 46'), /invalid result/)
})
