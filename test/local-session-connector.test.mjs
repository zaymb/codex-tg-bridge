import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { AppServerRpcError } from '../src/app-server-client.mjs'
import { LocalSessionConnector } from '../src/local-session-connector.mjs'

class FakeAppServer extends EventEmitter {
  calls = []
  failTurnStart = null

  async request(method, params) {
    this.calls.push({ method, params })
    if (method === 'thread/resume') return { thread: { id: 'thread-a', turns: [] } }
    if (method === 'turn/start') {
      if (this.failTurnStart) throw this.failTurnStart
      return { turn: { id: 'turn-tg' } }
    }
    throw new Error(`unexpected app-server request: ${method}`)
  }
}

class FakeRelay extends EventEmitter {
  frames = []
  hello = null

  async connect(hello) {
    this.hello = hello
  }

  send(frame) {
    this.frames.push(frame)
  }

  async close() {}
}

function fixture() {
  const app = new FakeAppServer()
  const relay = new FakeRelay()
  const connector = new LocalSessionConnector({
    appServerClient: app,
    relayClient: relay,
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    threadId: 'thread-a',
    heartbeatIntervalMs: 60_000,
  })
  return { app, relay, connector }
}

function job() {
  return {
    version: 1,
    type: 'job',
    job: {
      jobId: 'telegram:1',
      payload: {
        text: 'hello from Telegram',
        telegramContext: { chatId: '42', messageId: '10' },
      },
    },
  }
}

test('injects a Telegram job into the existing thread and returns its structured reply', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  assert.equal(setup.relay.hello.acceptingJobs, true)
  setup.relay.emit('frame', job())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.equal(started.params.threadId, 'thread-a')
  assert.equal(started.params.clientUserMessageId, 'telegram:1')
  assert.deepEqual(started.params.input, [{ type: 'text', text: 'hello from Telegram' }])
  assert.equal('cwd' in started.params, false)
  assert.equal(setup.relay.frames.at(-1).type, 'job_accepted')

  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      type: 'agentMessage',
      phase: 'final_answer',
      text: JSON.stringify({ action: 'send', text: 'final answer', reason: 'done' }),
    },
  })
  setup.app.emit('notification:turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-tg', status: 'completed' },
  })
  await setup.connector.idle()

  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_result',
    jobId: 'telegram:1',
    turnId: 'turn-tg',
    result: { action: 'reply', text: 'final answer', reason: 'done' },
  })
})

test('reports busy state for local TUI turns and becomes available after completion', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.app.emit('notification:turn/started', {
    threadId: 'thread-a',
    turn: { id: 'turn-local', status: 'inProgress' },
  })
  await setup.connector.idle()
  assert.equal(setup.relay.frames.at(-1).acceptingJobs, false)

  setup.app.emit('notification:turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-local', status: 'completed', items: [] },
  })
  await setup.connector.idle()
  assert.equal(setup.relay.frames.at(-1).acceptingJobs, true)
})

test('defers a Telegram job when a local turn wins the start race', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  setup.app.failTurnStart = new AppServerRpcError('thread already has an active turn', {
    method: 'turn/start',
    code: -32000,
  })
  await setup.connector.start()

  setup.relay.emit('frame', job())
  await setup.connector.idle()

  assert.equal(setup.relay.frames.at(-1).type, 'job_deferred')
  assert.match(setup.relay.frames.at(-1).reason, /active/)
})
