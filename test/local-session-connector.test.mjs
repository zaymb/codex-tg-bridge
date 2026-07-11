import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { AppServerRpcError } from '../src/app-server-client.mjs'
import { LocalSessionConnector } from '../src/local-session-connector.mjs'

class FakeAppServer extends EventEmitter {
  calls = []
  failTurnStart = null
  resumeThreads = [{ id: 'thread-a', turns: [] }]

  async request(method, params) {
    this.calls.push({ method, params })
    if (method === 'thread/resume') {
      return { thread: this.resumeThreads.length > 1 ? this.resumeThreads.shift() : this.resumeThreads[0] }
    }
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

function fixture({ heartbeatIntervalMs = 60_000 } = {}) {
  const app = new FakeAppServer()
  const relay = new FakeRelay()
  const connector = new LocalSessionConnector({
    appServerClient: app,
    relayClient: relay,
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    threadId: 'thread-a',
    heartbeatIntervalMs,
  })
  return { app, relay, connector }
}

function batch() {
  return {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: 'batch:telegram:1:telegram:2',
      jobs: [
        {
          jobId: 'telegram:1',
          payload: {
            text: 'first message',
            telegramContext: {
              chatId: '42',
              messageId: '10',
              senderId: '101',
              senderDisplayName: 'Alta',
            },
          },
        },
        {
          jobId: 'telegram:2',
          payload: {
            text: 'second message',
            telegramContext: {
              chatId: '42',
              messageId: '11',
              senderId: '202',
              senderUsername: 'laurie_bot',
              replyTo: { senderId: '101', senderDisplayName: 'Alta' },
            },
          },
        },
      ],
    },
  }
}

function legacyJob() {
  return {
    version: 1,
    type: 'job',
    job: {
      jobId: 'telegram:legacy',
      payload: {
        text: 'legacy Telegram message',
        telegramContext: { chatId: '42', messageId: '9' },
      },
    },
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('injects one ordered Codex turn for a Telegram batch and returns one batch result', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  assert.equal(setup.relay.hello.acceptingJobs, true)
  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.equal(started.params.threadId, 'thread-a')
  assert.equal(started.params.clientUserMessageId, 'batch:telegram:1:telegram:2')
  assert.equal(started.params.input.length, 1)
  assert.match(started.params.input[0].text, /1\. Alta: first message/)
  assert.match(started.params.input[0].text, /2\. laurie_bot \(replying to Alta\): second message/)
  assert.ok(started.params.input[0].text.indexOf('first message') < started.params.input[0].text.indexOf('second message'))
  assert.equal('cwd' in started.params, false)
  assert.deepEqual(JSON.parse(started.params.additionalContext.telegram.value), {
    batchId: 'batch:telegram:1:telegram:2',
    messageCount: 2,
    messages: batch().batch.jobs.map(job => job.payload.telegramContext),
  })
  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_accepted',
    batchId: 'batch:telegram:1:telegram:2',
    threadId: 'thread-a',
    turnId: 'turn-tg',
  })

  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      type: 'agentMessage',
      phase: 'final_answer',
      text: JSON.stringify({ action: 'send', text: 'one consolidated answer', reason: 'done' }),
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
    batchId: 'batch:telegram:1:telegram:2',
    turnId: 'turn-tg',
    result: { action: 'reply', text: 'one consolidated answer', reason: 'done' },
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

test('reconciles a pre-existing local turn and advertises availability when it ends', async t => {
  const setup = fixture({ heartbeatIntervalMs: 10 })
  t.after(() => setup.connector.close())
  setup.app.resumeThreads = [
    { id: 'thread-a', turns: [{ id: 'turn-local', status: 'inProgress' }] },
    { id: 'thread-a', turns: [{ id: 'turn-local', status: 'completed' }] },
  ]

  await setup.connector.start()
  assert.equal(setup.relay.hello.acceptingJobs, false)

  await waitFor(() => setup.relay.frames.some(frame => frame.type === 'heartbeat' && frame.acceptingJobs === true))
  assert.ok(setup.app.calls.filter(call => call.method === 'thread/resume').length >= 2)
})

test('defers the whole Telegram batch when a local turn wins the start race', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  setup.app.failTurnStart = new AppServerRpcError('thread already has an active turn', {
    method: 'turn/start',
    code: -32000,
  })
  await setup.connector.start()

  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_deferred',
    batchId: 'batch:telegram:1:telegram:2',
    reason: 'thread already has an active turn',
  })
})

test('accepts a legacy single-job frame during rolling deployment', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', legacyJob())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.deepEqual(started.params.input, [{ type: 'text', text: 'legacy Telegram message' }])
  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_accepted',
    jobId: 'telegram:legacy',
    threadId: 'thread-a',
    turnId: 'turn-tg',
  })
})
