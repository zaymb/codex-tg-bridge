import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { RelayProtocolSession } from '../src/relay-protocol.mjs'
import { StateStore } from '../src/state-store.mjs'

function fixture() {
  const state = StateStore.open(':memory:')
  const frames = []
  let now = 1_000
  const session = new RelayProtocolSession({
    stateStore: state,
    sessionLabel: 'tg-engage',
    writeFrame: frame => frames.push(frame),
    clock: () => now,
    leaseMs: 20_000,
    jobLeaseMs: 120_000,
    frameMaxBytes: 262_144,
  })
  return { state, frames, session, setNow(value) { now = value } }
}

function enqueue(state, updateId = '1', conversationKey = '42', nowMs = 1_000, contextOverrides = {}) {
  state.enqueueRelayJob({
    jobId: `telegram:${updateId}`,
    sourceType: 'telegram',
    sourceId: updateId,
    conversationKey,
    sessionLabel: 'tg-engage',
    payload: {
      text: `hello ${updateId}`,
      telegramContext: {
        chatId: conversationKey,
        conversationKey,
        messageId: String(Number(updateId) * 10),
        ...contextOverrides,
      },
    },
    expiresAtMs: nowMs + 86_400_000,
    nowMs,
  })
}

async function hello(setup, acceptingJobs = true) {
  await setup.session.handleFrame({
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs,
  })
}

test('leases all currently pending jobs for the oldest conversation as one batch', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'group-a', 1_000)
  enqueue(setup.state, '2', 'group-a', 1_001)
  enqueue(setup.state, '3', 'group-b', 1_002)

  await hello(setup)
  assert.equal(setup.frames[0].type, 'ready')
  assert.equal(await setup.session.claimOnce(), true)
  const frame = setup.frames[1]
  assert.equal(frame.type, 'job_batch')
  assert.deepEqual(frame.batch.jobs.map(job => job.jobId), ['telegram:1', 'telegram:2'])
  assert.equal(setup.state.getRelayJob('telegram:3').status, 'pending')
  assert.equal(await setup.session.claimOnce(), false)

  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId: frame.batch.batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'accepted')
  assert.equal(setup.state.getRelayJob('telegram:2').turnId, 'turn-a')
})

test('records one final reply for the batch using the latest Telegram message', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000)
  enqueue(setup.state, '2', '42', 1_001)
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: { action: 'reply', text: 'one final answer' },
  })

  assert.equal(setup.state.getRelayJob('telegram:1').status, 'completed')
  assert.equal(setup.state.getRelayJob('telegram:2').status, 'completed')
  const outbound = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  assert.equal(outbound.actionType, 'reply')
  assert.equal(outbound.payload.messageId, '20')
  assert.equal(outbound.payload.text, 'one final answer')
  assert.equal(setup.frames.at(-1).type, 'job_recorded')
  assert.deepEqual(setup.frames.at(-1).jobIds, ['telegram:1', 'telegram:2'])
})

test('records a first-class reaction against the latest Telegram message', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000)
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: { action: 'react', text: '🗿' },
  })

  const outbound = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  assert.equal(outbound.actionType, 'react')
  assert.deepEqual(outbound.payload, {
    chatId: '42',
    messageId: '10',
    reaction: { type: 'emoji', emoji: '🗿' },
    isBig: false,
  })
})

test('records selective targeted responses to messages from the same batch', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000)
  enqueue(setup.state, '2', '42', 1_001)
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: {
      action: 'reply',
      text: '',
      responses: [
        { messageId: '10', text: 'first targeted answer' },
        { messageId: '20', text: 'second targeted answer' },
      ],
    },
  })

  const first = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  const second = setup.state.getOutboundAction(`relay-batch:${batchId}:0001`)
  assert.equal(first.actionType, 'reply')
  assert.equal(first.payload.messageId, '10')
  assert.equal(first.payload.text, 'first targeted answer')
  assert.equal(second.actionType, 'reply')
  assert.equal(second.payload.messageId, '20')
  assert.equal(second.payload.text, 'second targeted answer')
})

test('preserves the large-animation flag for a targeted reaction', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '31', '42', 1_000, { messageId: '31' })
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: {
      action: 'reply',
      text: '',
      responses: [{ messageId: '31', action: 'react', text: '🎉', isBig: true }],
    },
  })

  const action = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  assert.equal(action.actionType, 'react')
  assert.equal(action.payload.isBig, true)
})

test('routes identical message IDs independently across a DM, group, and forum topic', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000, { chatId: '42', messageId: '7' })
  enqueue(setup.state, '2', '-1001', 1_001, { chatId: '-1001', messageId: '7' })
  enqueue(setup.state, '3', '-1001:9', 1_002, { chatId: '-1001', threadId: '9', messageId: '7' })
  await hello(setup)

  const expected = [
    { chatId: '42', threadId: null },
    { chatId: '-1001', threadId: null },
    { chatId: '-1001', threadId: '9' },
  ]
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(await setup.session.claimOnce(), true)
    const { batchId } = setup.frames.at(-1).batch
    const turnId = `turn-${index}`
    await setup.session.handleFrame({
      version: 1,
      type: 'job_accepted',
      batchId,
      threadId: 'thread-a',
      turnId,
    })
    await setup.session.handleFrame({
      version: 1,
      type: 'job_result',
      batchId,
      turnId,
      result: { action: 'reply', text: '', responses: [{ messageId: '7', text: `answer-${index}` }] },
    })
    const outbound = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
    assert.equal(outbound.payload.chatId, expected[index].chatId)
    assert.equal(outbound.payload.threadId, expected[index].threadId)
    assert.equal(outbound.payload.messageId, '7')
    if (index < expected.length - 1) {
      await setup.session.handleFrame({ version: 1, type: 'heartbeat', acceptingJobs: true })
    }
  }
})

test('rejects reply context that disagrees with the durable conversation key', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000, {
    chatId: '-1001',
    conversationKey: '-1001',
    messageId: '7',
  })
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await assert.rejects(setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: { action: 'reply', text: 'must not cross chats' },
  }), /does not match its conversation/)
})

test('rejects targeted responses outside the current batch and duplicate targets', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000)
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await assert.rejects(setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: {
      action: 'reply',
      text: '',
      responses: [{ messageId: '999', text: 'wrong target' }],
    },
  }), /current batch/)
  await assert.rejects(setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: {
      action: 'reply',
      text: '',
      responses: [
        { messageId: '10', text: 'one' },
        { messageId: '10', text: 'two' },
      ],
    },
  }), /duplicate/)
})

test('records batch SKIP without outbound and rejects a mismatched turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state)
  await hello(setup)
  await setup.session.claimOnce()
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  await assert.rejects(setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'wrong-turn',
    result: { action: 'skip' },
  }), /does not match/)

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: { action: 'skip' },
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'completed')
  assert.equal(setup.state.claimDueOutboundActions({ workerId: 'probe', limit: 10, nowMs: 1_000 }).length, 0)
})

test('renews and releases the session lease and rejects protocol mismatches', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  await assert.rejects(setup.session.handleFrame({
    version: 2,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs: true,
  }), /protocol version/)

  await hello(setup)
  setup.setNow(5_000)
  await setup.session.handleFrame({ version: 1, type: 'heartbeat' })
  assert.equal(setup.state.getRelaySession('tg-engage', 24_999).status, 'online')
  await setup.session.close()
  assert.equal(setup.state.getRelaySession('tg-engage', 5_000).status, 'offline')
})

test('claims only while idle and defers the whole batch after a start race', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'group-a', 1_000)
  enqueue(setup.state, '2', 'group-a', 1_001)
  await hello(setup, false)
  assert.equal(await setup.session.claimOnce(), false)

  await setup.session.handleFrame({ version: 1, type: 'heartbeat', acceptingJobs: true })
  assert.equal(await setup.session.claimOnce(), true)
  const { batchId } = setup.frames.at(-1).batch
  await setup.session.handleFrame({
    version: 1,
    type: 'job_deferred',
    batchId,
    reason: 'target thread became active',
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'pending')
  assert.equal(setup.state.getRelayJob('telegram:2').status, 'pending')
  assert.equal(await setup.session.claimOnce(), false)
})

test('durably routes a local app-server approval through the owner DM', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.setSetting('telegram_owner_user_id', '42', 1_000)
  await hello(setup, false)

  await setup.session.handleFrame({
    version: 1,
    type: 'approval_request',
    approval: {
      approvalId: 'approval-12345678',
      method: 'item/commandExecution/requestApproval',
      threadId: 'session-a',
      turnId: 'turn-local',
      detail: 'Codex requests command execution approval.\nCommand: git push',
      expiresAtMs: 11_000,
    },
  })

  const action = setup.state.getOutboundAction('relay-approval:approval-12345678')
  assert.equal(action.conversationKey, '42')
  assert.equal(action.payload.chatId, '42')
  const callbackData = action.payload.replyMarkup.inline_keyboard[0][0].callback_data
  const token = callbackData.match(/^ra:([^:]+):approve$/u)[1]
  assert.equal(setup.state.resolveRelayApproval({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerUserId: '42',
    decision: 'approved',
    nowMs: 2_000,
  }).resolved, true)

  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1), {
    version: 1,
    type: 'approval_response',
    approvalId: 'approval-12345678',
    decision: 'approve',
    reason: 'approved',
  })
  await setup.session.handleFrame({
    version: 1,
    type: 'approval_recorded',
    approvalId: 'approval-12345678',
  })
  assert.equal(setup.state.getRelayApproval('approval-12345678').deliveredAtMs, 1_000)
})
