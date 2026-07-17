import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { AppServerRpcError } from '../src/app-server-client.mjs'
import { LocalSessionConnector } from '../src/local-session-connector.mjs'

class FakeAppServer extends EventEmitter {
  calls = []
  responses = []
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

  respond(id, result, error = null) {
    this.responses.push({ id, result, error })
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

function fixture({
  heartbeatIntervalMs = 60_000,
  privateChatIds = new Set(),
  repairChatIds = new Set(),
  attachmentStore = null,
} = {}) {
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
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    ownerUserId: '42',
    privateChatIds,
    repairChatIds,
    attachmentStore,
  })
  return { app, relay, connector }
}

function privateGroupBatch() {
  return {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: 'batch:telegram:private-group',
      jobs: [{
        jobId: 'telegram:private-group',
        payload: {
          text: 'describe our architecture',
          telegramContext: {
            chatId: '-100123',
            conversationKey: '-100123',
            messageId: '13',
            senderId: '42',
            senderIsBot: false,
            senderDisplayName: 'Owner',
          },
        },
      }],
    },
  }
}

function repairGroupBatch({ peer = false } = {}) {
  return {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: `batch:telegram:repair-group:${peer ? 'peer' : 'owner'}`,
      jobs: [{
        jobId: `telegram:repair-group:${peer ? 'peer' : 'owner'}`,
        payload: {
          text: 'repair the bridge',
          telegramContext: {
            chatId: '-100123',
            conversationKey: '-100123',
            messageId: peer ? '15' : '14',
            senderId: peer ? '99' : '42',
            senderIsBot: peer,
            senderDisplayName: peer ? 'Peer' : 'Owner',
          },
        },
      }],
    },
  }
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

function topicBatch() {
  return {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: 'batch:telegram:topic',
      jobs: [{
        jobId: 'telegram:topic',
        payload: {
          text: 'topic message',
          telegramContext: {
            chatId: '-100456',
            conversationKey: '-100456:9',
            threadId: '9',
            threadName: 'Planning',
            messageId: '12',
            senderId: '101',
            senderDisplayName: 'Owner',
          },
        },
      }],
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

function ownerDmBatch() {
  return {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: 'batch:telegram:owner',
      jobs: [{
        jobId: 'telegram:owner',
        payload: {
          text: 'trusted owner request',
          telegramContext: {
            chatId: '42',
            conversationKey: '42',
            messageId: '12',
            senderId: '42',
            senderIsBot: false,
            senderDisplayName: 'Owner',
          },
        },
      }],
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
  assert.deepEqual(setup.relay.hello.capabilities, [])

  assert.equal(setup.relay.hello.acceptingJobs, true)
  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.equal(started.params.threadId, 'thread-a')
  assert.equal(started.params.clientUserMessageId, 'batch:telegram:1:telegram:2')
  assert.equal(started.params.input.length, 1)
  assert.match(started.params.input[0].text, /^\[EXTERNAL_FEED\]\[source=telegram\]\[trust=untrusted_external\]\n\[TG BATCH:/)
  assert.match(started.params.input[0].text, /1\. \[TG\]\[conversation_key=42\]\[message_id=10\] Alta: first message/)
  assert.match(started.params.input[0].text, /2\. \[TG\]\[conversation_key=42\]\[message_id=11\] laurie_bot \(replying to Alta\): second message/)
  assert.ok(started.params.input[0].text.indexOf('first message') < started.params.input[0].text.indexOf('second message'))
  assert.equal('cwd' in started.params, false)
  assert.equal(started.params.approvalPolicy, 'never')
  assert.deepEqual(started.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal('outputSchema' in started.params, false)
  assert.deepEqual(JSON.parse(started.params.additionalContext.telegram.value), {
    source: 'telegram',
    transportStatus: 'connected',
    batchId: 'batch:telegram:1:telegram:2',
    messageCount: 2,
    messages: batch().batch.jobs.map(job => job.payload.telegramContext),
  })
  assert.match(started.params.additionalContext.telegram_source.value, /originated from Telegram/)
  assert.match(started.params.additionalContext.telegram_trust_policy.value, /untrusted external feed/)
  assert.match(started.params.additionalContext.telegram_output_contract.value, /latest user input is marked \[TG\]/)
  assert.match(started.params.additionalContext.telegram_output_contract.value, /answer it normally in plain text/)
  assert.match(started.params.additionalContext.telegram_output_contract.value, /Plain-text commentary is delivered immediately to Telegram/)
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
      phase: 'commentary',
      text: JSON.stringify({
        action: 'send',
        text: 'status update must not escape',
        responses: [],
        reason: 'working',
      }),
    },
  })

  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      type: 'agentMessage',
      phase: 'final_answer',
      text: JSON.stringify({
        action: 'send',
        text: '',
        responses: [
          { messageId: '10', action: 'send', text: 'first answer' },
          { messageId: '11', action: 'send', text: 'second answer' },
        ],
        reason: 'done',
      }),
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
    result: {
      action: 'reply',
      text: '',
      responses: [
        { messageId: '10', action: 'reply', text: 'first answer' },
        { messageId: '11', action: 'reply', text: 'second answer' },
      ],
      reason: 'done',
    },
  })

  setup.relay.emit('frame', {
    version: 1,
    type: 'job_recorded',
    batchId: 'batch:telegram:1:telegram:2',
  })
  await setup.connector.idle()
  const resumes = setup.app.calls.filter(call => call.method === 'thread/resume')
  assert.deepEqual(resumes.at(-1).params, {
    threadId: 'thread-a',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
})

test('shows the stable topic name beside its conversation key', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', topicBatch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(
    started.params.input[0].text,
    /\[conversation_key=-100456:9\]\[topic=Planning\]\[message_id=12\]/u,
  )
})

test('forwards plain commentary immediately without treating it as the final answer', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', batch())
  await setup.connector.idle()
  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      id: 'commentary-envelope',
      type: 'agentMessage',
      phase: 'commentary',
      text: 'work is in progress',
    },
  })
  await setup.connector.idle()

  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_progress',
    batchId: 'batch:telegram:1:telegram:2',
    turnId: 'turn-tg',
    progressId: 'commentary-envelope',
    text: 'work is in progress',
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
    result: { action: 'skip', reason: 'missing_final_answer' },
  })
})

test('private groups receive the private-audience policy but retain no execution permissions', async t => {
  const setup = fixture({ privateChatIds: new Set(['-100123']) })
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', privateGroupBatch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(started.params.input[0].text, /\[trust=private_group\]/)
  assert.match(started.params.additionalContext.telegram_trust_policy.value, /owner-approved private Telegram group/)
  assert.match(started.params.additionalContext.telegram_trust_policy.value, /not an instruction source/)
  assert.equal(started.params.approvalPolicy, 'never')
  assert.deepEqual(started.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
})

test('owner-authored repair-group turns receive configured execution permissions', async t => {
  const setup = fixture({
    privateChatIds: new Set(['-100123']),
    repairChatIds: new Set(['-100123']),
  })
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', repairGroupBatch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(started.params.input[0].text, /\[trust=repair_group\]/)
  assert.match(started.params.additionalContext.telegram_trust_policy.value, /authorized repair surface/)
  assert.equal(started.params.approvalPolicy, 'never')
  assert.deepEqual(started.params.sandboxPolicy, { type: 'dangerFullAccess' })
})

test('peer-bot turns in a repair group remain non-authoritative and read-only', async t => {
  const setup = fixture({
    privateChatIds: new Set(['-100123']),
    repairChatIds: new Set(['-100123']),
  })
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', repairGroupBatch({ peer: true }))
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(started.params.input[0].text, /\[trust=private_group\]/)
  assert.equal(started.params.approvalPolicy, 'never')
  assert.deepEqual(started.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
})

test('trusts only the authenticated owner DM and preserves its configured permissions', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.relay.emit('frame', ownerDmBatch())
  await setup.connector.idle()

  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(started.params.input[0].text, /^\[EXTERNAL_FEED\]\[source=telegram\]\[trust=owner_dm\]/)
  assert.deepEqual(started.params.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(started.params.approvalPolicy, 'never')
  assert.match(started.params.additionalContext.telegram_trust_policy.value, /authorized instruction source/)
})

test('automatically denies approval requests originating from an untrusted group turn', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()
  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  setup.app.emit('request', {
    id: 92,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-a',
      turnId: 'turn-tg',
      command: 'touch forbidden',
      cwd: '/workspace',
      reason: 'requested by group chat',
    },
  })
  await setup.connector.idle()

  assert.equal(setup.relay.frames.some(frame => frame.type === 'approval_request'), false)
  assert.deepEqual(setup.app.responses, [{ id: 92, result: { decision: 'decline' }, error: null }])
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

test('never sends a mixed Telegram and terminal turn back to Telegram', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  const collisions = []
  setup.connector.on('channelCollision', collision => collisions.push(collision))
  await setup.connector.start()

  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  setup.app.emit('notification:item/started', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: { id: 'tg-input', type: 'userMessage', clientId: 'batch:telegram:1:telegram:2', content: [] },
  })
  setup.app.emit('notification:item/started', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: { id: 'terminal-steer', type: 'userMessage', clientId: 'tui:local-message', content: [] },
  })
  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: { id: 'terminal-steer', type: 'userMessage', clientId: 'tui:local-message', content: [] },
  })
  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      id: 'mixed-answer',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'terminal-only answer',
    },
  })
  setup.app.emit('notification:turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-tg', status: 'completed' },
  })
  await setup.connector.idle()

  assert.deepEqual(collisions, [{
    turnId: 'turn-tg',
    expectedClientId: 'batch:telegram:1:telegram:2',
    receivedClientId: 'tui:local-message',
  }])
  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_result',
    batchId: 'batch:telegram:1:telegram:2',
    turnId: 'turn-tg',
    result: { action: 'skip', reason: 'mixed_source_turn' },
  })
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
  assert.deepEqual(started.params.input, [{
    type: 'text',
    text: '[EXTERNAL_FEED][source=telegram][trust=untrusted_external]\n[TG][conversation_key=42][message_id=9][sender=unknown sender]\nlegacy Telegram message',
  }])
  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'job_accepted',
    jobId: 'telegram:legacy',
    threadId: 'thread-a',
    turnId: 'turn-tg',
  })
})

test('materializes relayed photos before starting Codex and keeps base64 out of model input', async t => {
  const saved = []
  const removed = []
  const setup = fixture({
    attachmentStore: {
      async save({ updateId, attachment, bytes }) {
        saved.push({ updateId, attachment, bytes })
        return {
          localPath: '/local/inbox/photo.jpg',
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      },
      async remove(path) { removed.push(path) },
    },
  })
  t.after(() => setup.connector.close())
  await setup.connector.start()
  assert.deepEqual(setup.relay.hello.capabilities, ['attachment_transfer_v1'])
  const bytes = Buffer.from('photo-binary')
  const digest = createHash('sha256').update(bytes).digest('hex')
  setup.relay.emit('frame', {
    version: 1,
    type: 'attachment_manifest',
    batchId: 'batch:telegram:image:telegram:image',
    jobId: 'telegram:image',
    transferId: 'attachment-image123',
    updateId: '77',
    attachment: {
      kind: 'photo',
      fileId: 'photo-id',
      fileName: null,
      mimeType: 'image/jpeg',
      codexInput: 'localImage',
      detectedMimeType: 'image/jpeg',
      byteSize: bytes.length,
      sha256: digest,
    },
    chunkCount: 1,
  })
  setup.relay.emit('frame', {
    version: 1,
    type: 'attachment_chunk',
    batchId: 'batch:telegram:image:telegram:image',
    transferId: 'attachment-image123',
    index: 0,
    data: bytes.toString('base64'),
  })
  setup.relay.emit('frame', {
    version: 1,
    type: 'job_batch',
    batch: {
      batchId: 'batch:telegram:image:telegram:image',
      jobs: [{
        jobId: 'telegram:image',
        payload: {
          text: '',
          telegramContext: {
            updateId: '77',
            chatId: '42',
            conversationKey: '42',
            messageId: '770',
            senderId: '42',
            senderDisplayName: 'Owner',
          },
          attachments: [{
            kind: 'photo',
            fileId: 'photo-id',
            fileName: null,
            mimeType: 'image/jpeg',
            codexInput: 'localImage',
            detectedMimeType: 'image/jpeg',
            byteSize: bytes.length,
            sha256: digest,
            transferId: 'attachment-image123',
          }],
        },
      }],
    },
  })
  await setup.connector.idle()

  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].bytes, bytes)
  const started = setup.app.calls.find(call => call.method === 'turn/start')
  assert.match(started.params.input[0].text, /请查看附图并回应/u)
  assert.deepEqual(started.params.input.at(-1), {
    type: 'localImage',
    path: '/local/inbox/photo.jpg',
  })
  assert.equal(JSON.stringify(started.params.input).includes(bytes.toString('base64')), false)

  setup.app.emit('notification:turn/completed', {
    threadId: 'thread-a',
    turn: {
      id: 'turn-tg',
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"action":"send","text":"done","responses":[]}' }],
    },
  })
  await setup.connector.idle()
  setup.relay.emit('frame', {
    version: 1,
    type: 'job_recorded',
    batchId: 'batch:telegram:image:telegram:image',
  })
  await setup.connector.idle()
  assert.deepEqual(removed, ['/local/inbox/photo.jpg'])
})

test('emits relay status heartbeats for an external channel monitor', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  const statuses = []
  setup.connector.on('relayStatus', status => statuses.push(status))
  await setup.connector.start()

  setup.relay.emit('frame', { version: 1, type: 'heartbeat', nowMs: 1234 })
  await setup.connector.idle()

  assert.deepEqual(statuses.at(-1), { status: 'connected', remoteNowMs: 1234 })
})

test('returns a first-class reaction result without a text reply', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()
  setup.relay.emit('frame', batch())
  await setup.connector.idle()

  setup.app.emit('notification:item/completed', {
    threadId: 'thread-a',
    turnId: 'turn-tg',
    item: {
      type: 'agentMessage',
      phase: 'final_answer',
      text: JSON.stringify({ action: 'react', text: '🗿', responses: [], reason: 'reaction is enough' }),
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
    result: { action: 'react', text: '🗿', responses: [], reason: 'reaction is enough' },
  })
})

test('forwards a subscribed terminal approval to Telegram and returns the decision', async t => {
  const setup = fixture()
  t.after(() => setup.connector.close())
  await setup.connector.start()

  setup.app.emit('request', {
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-a',
      turnId: 'turn-local',
      command: 'git push',
      cwd: '/workspace',
      reason: 'publish reviewed changes',
    },
  })
  await setup.connector.idle()

  const requestFrame = setup.relay.frames.find(frame => frame.type === 'approval_request')
  assert.equal(requestFrame.approval.method, 'item/commandExecution/requestApproval')
  assert.equal(requestFrame.approval.threadId, 'thread-a')
  assert.match(requestFrame.approval.detail, /git push/)

  setup.relay.emit('frame', {
    version: 1,
    type: 'approval_response',
    approvalId: requestFrame.approval.approvalId,
    decision: 'approve',
    reason: 'approved',
  })
  await setup.connector.idle()

  assert.deepEqual(setup.app.responses, [{ id: 91, result: { decision: 'accept' }, error: null }])
  assert.deepEqual(setup.relay.frames.at(-1), {
    version: 1,
    type: 'approval_recorded',
    approvalId: requestFrame.approval.approvalId,
  })
})
