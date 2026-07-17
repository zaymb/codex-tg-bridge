import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RelayProtocolSession } from '../src/relay-protocol.mjs'
import { StateStore } from '../src/state-store.mjs'

function fixture({ coalesceQuietMs = 0, coalesceMaxMs = 0, removeAttachment = null } = {}) {
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
    coalesceQuietMs,
    coalesceMaxMs,
    removeAttachment,
  })
  return { state, frames, session, setNow(value) { now = value } }
}

function enqueue(
  state,
  updateId = '1',
  conversationKey = '42',
  nowMs = 1_000,
  contextOverrides = {},
  payloadOverrides = {},
) {
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
      ...payloadOverrides,
    },
    expiresAtMs: nowMs + 86_400_000,
    nowMs,
  })
}

test('waits for a quiet interval and resets it when a follow-up arrives', async t => {
  const setup = fixture({ coalesceQuietMs: 7_000, coalesceMaxMs: 30_000 })
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'group-a', 1_000)
  await hello(setup)

  setup.setNow(7_999)
  assert.equal(await setup.session.claimOnce(), false)
  enqueue(setup.state, '2', 'group-a', 5_000)
  setup.setNow(11_999)
  assert.equal(await setup.session.claimOnce(), false)

  setup.setNow(12_000)
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), [
    'telegram:1',
    'telegram:2',
  ])
})

test('dispatches a continuously extended burst at the hard cap', async t => {
  const setup = fixture({ coalesceQuietMs: 7_000, coalesceMaxMs: 30_000 })
  t.after(() => setup.state.close())
  for (const [id, nowMs] of [['1', 1_000], ['2', 7_000], ['3', 13_000], ['4', 19_000], ['5', 25_000]]) {
    enqueue(setup.state, id, 'group-a', nowMs)
  }
  await hello(setup)

  setup.setNow(30_999)
  assert.equal(await setup.session.claimOnce(), false)
  setup.setNow(31_000)
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), [
    'telegram:1',
    'telegram:2',
    'telegram:3',
    'telegram:4',
    'telegram:5',
  ])
})

test('waits for one global quiet interval before batching every pending source', async t => {
  const setup = fixture({ coalesceQuietMs: 7_000, coalesceMaxMs: 30_000 })
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'group-a', 1_000)
  enqueue(setup.state, '2', 'owner-dm', 7_000)
  await hello(setup)

  setup.setNow(8_000)
  assert.equal(await setup.session.claimOnce(), false)
  setup.setNow(14_000)
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), [
    'telegram:1',
    'telegram:2',
  ])
})

test('lets an explicit control bypass coalescing without crossing conversations', async t => {
  const setup = fixture({ coalesceQuietMs: 7_000, coalesceMaxMs: 30_000 })
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'group-a', 1_000)
  enqueue(setup.state, '2', 'owner-dm', 2_000, {}, {
    text: '/stop',
    dispatch: { bypassCoalesce: true },
  })
  await hello(setup)

  setup.setNow(2_000)
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), ['telegram:2'])
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'pending')
})

test('dispatches the bypass control instead of an earlier author in the same conversation', async t => {
  const setup = fixture({ coalesceQuietMs: 7_000, coalesceMaxMs: 30_000 })
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', 'repair-group', 1_000, { senderId: '99', senderIsBot: true })
  enqueue(setup.state, '2', 'repair-group', 2_000, { senderId: '42', senderIsBot: false }, {
    text: '/stop',
    dispatch: { bypassCoalesce: true },
  })
  await hello(setup)

  setup.setNow(2_000)
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), ['telegram:2'])
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'pending')
})

async function hello(setup, acceptingJobs = true, capabilities = []) {
  await setup.session.handleFrame({
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs,
    capabilities,
  })
}

test('negotiates attachment transfer and leaves attachment conversations pending for legacy connectors', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '90', 'group-with-file', 1_000, { updateId: '90' }, {
    attachments: [{
      kind: 'document',
      fileId: 'file-a',
      localPath: '/not-read-by-legacy-connector',
      byteSize: 1,
      sha256: '0'.repeat(64),
    }],
  })
  enqueue(setup.state, '91', 'group-with-text', 1_001)

  await hello(setup)
  assert.deepEqual(setup.frames[0].capabilities, [])
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), ['telegram:91'])
  assert.equal(setup.state.getRelayJob('telegram:90').status, 'pending')
})

test('sends attachment frames only after the connector advertises the capability', async t => {
  const removed = []
  const setup = fixture({ removeAttachment: async path => { removed.push(path) } })
  const root = await mkdtemp(join(tmpdir(), 'relay-protocol-attachment-'))
  t.after(async () => {
    setup.state.close()
    await rm(root, { recursive: true, force: true })
  })
  const localPath = join(root, 'photo.jpg')
  const bytes = Buffer.from('photo')
  await writeFile(localPath, bytes)
  enqueue(setup.state, '92', 'group-with-file', 1_000, { updateId: '92' }, {
    attachments: [{
      kind: 'photo',
      fileId: 'photo-a',
      localPath,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  })

  await hello(setup, true, ['attachment_transfer_v1'])
  assert.deepEqual(setup.frames[0].capabilities, ['attachment_transfer_v1'])
  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.slice(1).map(frame => frame.type), [
    'attachment_manifest',
    'attachment_chunk',
    'job_batch',
  ])
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    batchId: setup.frames.at(-1).batch.batchId,
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  assert.deepEqual(removed, [localPath])
})

test('leases all currently pending conversations as one batch', async t => {
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
  assert.deepEqual(frame.batch.jobs.map(job => job.jobId), ['telegram:1', 'telegram:2', 'telegram:3'])
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
  assert.equal(setup.state.getRelayJob('telegram:3').turnId, 'turn-a')
})

test('fails only the poison attachment job and keeps the relay usable', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '91', '42', 1_000, { updateId: '91' }, {
    attachments: [{
      kind: 'document',
      fileId: 'missing-file',
      localPath: '/definitely/missing/relay-attachment.bin',
      byteSize: 1,
      sha256: '0'.repeat(64),
    }],
  })
  enqueue(setup.state, '92', 'other-conversation', 1_001)
  await hello(setup, true, ['attachment_transfer_v1'])

  assert.equal(await setup.session.claimOnce(), true)
  assert.equal(setup.state.getRelayJob('telegram:91').status, 'failed')
  assert.match(setup.state.getRelayJob('telegram:91').lastError, /ENOENT/)

  assert.equal(await setup.session.claimOnce(), true)
  assert.deepEqual(setup.frames.at(-1).batch.jobs.map(job => job.jobId), ['telegram:92'])
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

test('queues an in-progress reply without completing the accepted batch', async t => {
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
    type: 'job_progress',
    batchId,
    turnId: 'turn-a',
    progressId: 'commentary-1',
    text: 'work is in progress',
  })

  assert.equal(setup.state.getRelayJob('telegram:1').status, 'accepted')
  assert.equal(setup.state.getRelayJob('telegram:2').status, 'accepted')
  const outbound = setup.state.claimDueOutboundActions({
    workerId: 'progress-probe',
    limit: 10,
    nowMs: 1_000,
  })
  assert.equal(outbound.length, 1)
  assert.equal(outbound[0].actionType, 'reply')
  assert.equal(outbound[0].payload.messageId, '20')
  assert.equal(outbound[0].payload.text, 'work is in progress')
  assert.equal(setup.frames.some(frame => frame.type === 'job_recorded'), false)
})

test('a final result supersedes progress that has not been delivered', async t => {
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
    type: 'job_progress',
    batchId,
    turnId: 'turn-a',
    progressId: 'commentary-1',
    text: 'work is in progress',
  })

  const progressKey = createHash('sha256')
    .update('turn-a\0commentary-1')
    .digest('hex')
    .slice(0, 32)
  const progressId = `relay-batch:${batchId}:progress:${progressKey}:0000`
  assert.equal(setup.state.getOutboundAction(progressId).status, 'pending')

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    batchId,
    turnId: 'turn-a',
    result: { action: 'reply', text: 'final answer' },
  })

  const progress = setup.state.getOutboundAction(progressId)
  assert.equal(progress.status, 'failed')
  assert.equal(progress.nextAttemptAtMs, null)
  assert.match(progress.lastError, /superseded by final relay result/u)
  assert.equal(setup.state.getOutboundAction(`relay-batch:${batchId}:0000`).status, 'pending')
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

test('records a targeted Telegram dice response with reply routing', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '32', '42', 1_000, { messageId: '32' })
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
      responses: [{ messageId: '32', action: 'dice', text: '🎳' }],
    },
  })

  const action = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  assert.equal(action.actionType, 'send_dice')
  assert.deepEqual(action.payload, {
    chatId: '42',
    threadId: null,
    replyToMessageId: '32',
    emoji: '🎳',
  })
})

test('routes identical message IDs independently across one mixed-source batch', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000, { chatId: '42', messageId: '7' })
  enqueue(setup.state, '2', '-1001', 1_001, { chatId: '-1001', messageId: '7' })
  enqueue(setup.state, '3', '-1001:9', 1_002, { chatId: '-1001', threadId: '9', messageId: '7' })
  await hello(setup)

  assert.equal(await setup.session.claimOnce(), true)
  const { batchId, jobs } = setup.frames.at(-1).batch
  assert.deepEqual(jobs.map(job => job.jobId), ['telegram:1', 'telegram:2', 'telegram:3'])
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
        { conversationKey: '42', messageId: '7', text: 'answer-0' },
        { conversationKey: '-1001', messageId: '7', text: 'answer-1' },
        { conversationKey: '-1001:9', messageId: '7', text: 'answer-2' },
      ],
    },
  })

  const expected = [
    { chatId: '42', threadId: null },
    { chatId: '-1001', threadId: null },
    { chatId: '-1001', threadId: '9' },
  ]
  for (let index = 0; index < expected.length; index += 1) {
    const outbound = setup.state.getOutboundAction(`relay-batch:${batchId}:${String(index).padStart(4, '0')}`)
    assert.equal(outbound.payload.chatId, expected[index].chatId)
    assert.equal(outbound.payload.threadId, expected[index].threadId)
    assert.equal(outbound.payload.messageId, '7')
  }
})

test('rejects an ambiguous target in a mixed-source batch without a conversation key', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000, { chatId: '42', messageId: '7' })
  enqueue(setup.state, '2', '-1001', 1_001, { chatId: '-1001', messageId: '7' })
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
      responses: [{ messageId: '7', text: 'ambiguous' }],
    },
  })

  assert.equal(setup.state.getRelayJob('telegram:1').status, 'failed')
  assert.match(setup.state.getRelayJob('telegram:1').lastError, /conversationKey.*ambiguous/u)
})

test('routes a root reply to the latest message across all sources', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1', '42', 1_000, { chatId: '42', messageId: '10' })
  enqueue(setup.state, '2', '-1001', 1_001, { chatId: '-1001', messageId: '20' })
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
    result: { action: 'reply', text: 'latest only' },
  })

  const outbound = setup.state.getOutboundAction(`relay-batch:${batchId}:0000`)
  assert.equal(outbound.conversationKey, '-1001')
  assert.equal(outbound.payload.messageId, '20')
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

test('fails targeted responses outside the current batch and duplicate targets', async t => {
  const cases = [
    {
      name: 'outside batch',
      responses: [{ messageId: '999', text: 'wrong target' }],
      error: /current batch/,
    },
    {
      name: 'duplicate target',
      responses: [
        { messageId: '10', text: 'one' },
        { messageId: '10', text: 'two' },
      ],
      error: /duplicate/,
    },
  ]
  for (const testCase of cases) {
    await t.test(testCase.name, async t => {
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
        result: { action: 'reply', text: '', responses: testCase.responses },
      })

      const job = setup.state.getRelayJob('telegram:1')
      assert.equal(job.status, 'failed')
      assert.match(job.lastError, testCase.error)
      assert.equal(setup.frames.at(-1).type, 'job_recorded')
    })
  }
})

test('fails only the accepted batch when a model result is malformed', async t => {
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
    result: {
      action: 'reply',
      text: 'duplicate answer',
      responses: [{ messageId: '10', text: 'duplicate answer' }],
    },
  })

  const job = setup.state.getRelayJob('telegram:1')
  assert.equal(job.status, 'failed')
  assert.match(job.lastError, /cannot combine text with targeted responses/)
  assert.equal(setup.frames.at(-1).type, 'job_recorded')
  assert.equal(setup.session.ready, true)
})

test('fails an accepted inflight batch when its relay session closes', async t => {
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

  await setup.session.close()

  const job = setup.state.getRelayJob('telegram:1')
  assert.equal(job.status, 'failed')
  assert.match(job.lastError, /disconnected before recording a result/)
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
