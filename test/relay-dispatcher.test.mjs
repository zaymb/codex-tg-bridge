import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { EngagementPolicy } from '../src/engagement-policy.mjs'
import { RELAY_JOB_TTL_MS, RelayDispatcher } from '../src/relay-dispatcher.mjs'
import { StateStore } from '../src/state-store.mjs'

function rawMessage(updateId, { text = 'hello' } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      text,
    },
  }
}

function policy() {
  return new EngagementPolicy({
    ownerUserId: '42',
    allowedChatIds: new Set(['-100123', '-100456']),
    allowedChannelIds: new Set(),
  }, { botUserId: '500', botUsername: 'bridge_bot' })
}

function fixture({ telegramClient = null, attachmentStore = null, topicNames = new Map() } = {}) {
  const state = StateStore.open(':memory:')
  let now = 1_000
  const dispatcher = new RelayDispatcher({
    stateStore: state,
    engagementPolicy: policy(),
    sessionLabel: 'tg-engage',
    ownerUserId: '42',
    workerId: 'relay-test',
    updateLeaseMs: 10_000,
    clock: () => now,
    telegramClient,
    attachmentStore,
    topicNames,
  })
  return { state, dispatcher, setNow(value) { now = value } }
}

test('downloads attachments only after policy approval and queues verified transfer metadata', async t => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const hash = createHash('sha256').update(bytes).digest('hex')
  const downloads = []
  const setup = fixture({
    telegramClient: {
      async downloadFile(fileId, options) {
        downloads.push(fileId)
        assert.deepEqual(options, { maxBytes: 20_000_000 })
        return { bytes }
      },
    },
    attachmentStore: {
      async save({ updateId, attachment, bytes: received }) {
        assert.equal(updateId, '11')
        assert.equal(attachment.kind, 'photo')
        assert.deepEqual(received, bytes)
        return {
          localPath: '/remote/attachments/11/photo.jpg',
          byteSize: received.length,
          sha256: hash,
        }
      },
    },
  })
  t.after(() => setup.state.close())
  const raw = rawMessage(11)
  delete raw.message.text
  raw.message.photo = [
    { file_id: 'small', file_unique_id: 'small-u', width: 20, height: 20, file_size: 5 },
    { file_id: 'large', file_unique_id: 'large-u', width: 640, height: 480, file_size: bytes.length },
  ]

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw)), {
    status: 'completed',
    action: 'queued',
  })
  assert.deepEqual(downloads, ['large'])
  assert.deepEqual(setup.state.getRelayJob('telegram:11').payload.attachments, [{
    kind: 'photo',
    fileId: 'large',
    uniqueId: 'large-u',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: bytes.length,
    width: 640,
    height: 480,
    durationSec: null,
    metadata: { variants: 2 },
    codexInput: 'localImage',
    detectedMimeType: 'image/jpeg',
    localPath: '/remote/attachments/11/photo.jpg',
    byteSize: bytes.length,
    sha256: hash,
  }])
  assert.equal(setup.state.getAttachmentByFileId('large').sha256, hash)
})

test('marks verified image documents for native Codex image input', async t => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const hash = createHash('sha256').update(bytes).digest('hex')
  const setup = fixture({
    telegramClient: { async downloadFile() { return { bytes } } },
    attachmentStore: {
      async save() {
        return { localPath: '/remote/attachments/13/diagram.png', byteSize: bytes.length, sha256: hash }
      },
    },
  })
  t.after(() => setup.state.close())
  const raw = rawMessage(13)
  delete raw.message.text
  raw.message.document = {
    file_id: 'diagram',
    file_unique_id: 'diagram-u',
    file_name: 'diagram.png',
    mime_type: 'application/octet-stream',
    file_size: bytes.length,
  }

  const result = await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw))

  assert.deepEqual(result, { status: 'completed', action: 'queued' })
  assert.match(setup.state.getRelayJob('telegram:13').payload.attachments[0].localPath, /diagram\.png$/u)
  assert.equal(setup.state.getRelayJob('telegram:13').payload.attachments[0].codexInput, 'localImage')
  assert.equal(setup.state.getRelayJob('telegram:13').payload.attachments[0].detectedMimeType, 'image/png')
})

test('does not stage a claimed image whose bytes contradict its metadata', async t => {
  let saves = 0
  const setup = fixture({
    telegramClient: { async downloadFile() { return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } } },
    attachmentStore: { async save() { saves += 1 } },
  })
  t.after(() => setup.state.close())
  const raw = rawMessage(14)
  delete raw.message.text
  raw.message.document = {
    file_id: 'wrong',
    file_name: 'wrong.png',
    mime_type: 'image/png',
    file_size: 4,
  }

  const result = await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw))

  assert.equal(result.status, 'failed')
  assert.match(result.error.message, /metadata did not match/u)
  assert.equal(saves, 0)
  assert.equal(setup.state.getRelayJob('telegram:14'), null)
})

test('does not download an attachment rejected by the engagement policy', async t => {
  let downloads = 0
  const setup = fixture({
    telegramClient: { async downloadFile() { downloads += 1; return { bytes: Buffer.from('x') } } },
    attachmentStore: { async save() { throw new Error('must not save') } },
  })
  t.after(() => setup.state.close())
  const raw = rawMessage(12)
  delete raw.message.text
  raw.message.chat = { id: -999, type: 'supergroup' }
  raw.message.photo = [{ file_id: 'blocked', width: 10, height: 10, file_size: 1 }]

  const result = await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw))

  assert.equal(result.status, 'completed')
  assert.notEqual(result.action, 'queued')
  assert.equal(downloads, 0)
})

function storeAndClaim(state, raw, nowMs = 1_000) {
  state.storeUpdate({
    updateId: String(raw.update_id),
    raw,
    normalizedType: 'message',
    nowMs,
  })
  return state.claimUpdates({ workerId: 'relay-test', limit: 1, leaseMs: 10_000, nowMs })[0]
}

test('queues an approved Telegram update as a durable 24-hour relay job', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const row = storeAndClaim(setup.state, rawMessage(1, { text: 'work on this' }))

  const result = await setup.dispatcher.processClaimedUpdate(row)

  assert.deepEqual(result, { status: 'completed', action: 'queued' })
  assert.equal(setup.state.getUpdate('1').status, 'completed')
  const job = setup.state.getRelayJob('telegram:1')
  assert.equal(job.status, 'pending')
  assert.equal(job.expiresAtMs, 1_000 + RELAY_JOB_TTL_MS)
  assert.deepEqual(job.payload, {
    text: 'work on this',
    telegramContext: {
      updateId: '1',
      updateType: 'message',
      chatId: '42',
      conversationKey: '42',
      threadId: null,
      messageId: '10',
      senderId: '42',
      senderIsBot: false,
      senderUsername: null,
      senderDisplayName: 'Owner',
      replyTo: null,
    },
  })
})

test('marks an owner DM slash command to bypass relay coalescing', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const row = storeAndClaim(setup.state, rawMessage(8, { text: '/stop' }))

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'queued',
  })
  assert.deepEqual(setup.state.getRelayJob('telegram:8').payload.dispatch, {
    bypassCoalesce: true,
  })
})

test('delivers Telegram dice results as legible relay text', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const raw = rawMessage(6)
  delete raw.message.text
  raw.message.dice = { emoji: '🎲', value: 5 }
  const row = storeAndClaim(setup.state, raw)

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'queued',
  })
  assert.equal(setup.state.getRelayJob('telegram:6').payload.text, 'Telegram dice result: 🎲 = 5.')
})

test('includes the replied-to message and actor identity in the relay job', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const raw = rawMessage(7, { text: 'yes, that one' })
  raw.message.from.username = 'owner'
  raw.message.message_thread_id = 9
  raw.message.chat = { id: -100123, type: 'supergroup', title: 'Sandbox', is_forum: true }
  raw.message.reply_to_message = {
    message_id: 63,
    date: 1,
    chat: raw.message.chat,
    from: {
      id: 500,
      is_bot: true,
      username: 'bridge_bot',
      first_name: 'Elio',
    },
    text: 'which option?',
  }
  setup.state.storeUpdate({
    updateId: '7',
    raw,
    normalizedType: 'message',
    nowMs: 1_000,
  })
  const [row] = setup.state.claimUpdates({
    workerId: 'relay-test',
    limit: 1,
    leaseMs: 10_000,
    nowMs: 1_000,
  })

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'queued',
  })
  assert.deepEqual(setup.state.getRelayJob('telegram:7').payload.telegramContext, {
    updateId: '7',
    updateType: 'message',
    chatId: '-100123',
    chatTitle: 'Sandbox',
    conversationKey: '-100123:9',
    threadId: '9',
    messageId: '70',
    senderId: '42',
    senderIsBot: false,
    senderUsername: 'owner',
    senderDisplayName: 'Owner',
    replyTo: {
      messageId: '63',
      senderId: '500',
      senderIsBot: true,
      senderUsername: 'bridge_bot',
      senderDisplayName: 'Elio',
      text: 'which option?',
    },
  })
})

test('adds the stable topic display name to a mapped relay context', async t => {
  const setup = fixture({ topicNames: new Map([['-100456:9', 'Support']]) })
  t.after(() => setup.state.close())
  const raw = rawMessage(9, { text: '@bridge_bot repair this' })
  raw.message.entities = [{ type: 'mention', offset: 0, length: 11 }]
  raw.message.message_thread_id = 9
  raw.message.chat = {
    id: -100456,
    type: 'supergroup',
    title: 'Family',
    is_forum: true,
  }
  const row = storeAndClaim(setup.state, raw)

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'queued',
  })
  assert.equal(
    setup.state.getRelayJob('telegram:9').payload.telegramContext.threadName,
    'Support',
  )
})

test('uses the normalized offline notice once per conversation and offline epoch', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(2)))
  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(3)))

  const first = setup.state.getOutboundAction('offline:tg-engage:1:42')
  assert.equal(first.payload.text, 'Codex 会话「tg-engage」当前不在线。')
  assert.equal(setup.state.getOutboundAction('offline:tg-engage:1:42:duplicate'), null)
  assert.equal(setup.state.claimDueOutboundActions({ workerId: 'probe', limit: 10, nowMs: 1_000 }).length, 1)

  setup.state.registerRelaySession({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    nowMs: 1_100,
  })
  setup.state.disconnectRelaySession({ sessionLabel: 'tg-engage', connectorId: 'connector-a', nowMs: 1_200 })
  setup.setNow(1_300)
  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(4), 1_300))

  assert.equal(setup.state.getOutboundAction('offline:tg-engage:2:42').payload.text,
    'Codex 会话「tg-engage」当前不在线。')
})

test('does not create an offline notice while the local session lease is online', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.registerRelaySession({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    nowMs: 1_000,
  })

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(5)))

  assert.equal(setup.state.claimDueOutboundActions({ workerId: 'probe', limit: 10, nowMs: 1_000 }).length, 0)
})

test('expires from durable Telegram receipt time, including the exact 24-hour boundary', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const raw = rawMessage(6)
  setup.state.storeUpdate({
    updateId: '6',
    raw,
    normalizedType: 'message',
    nowMs: 1_000,
  })
  setup.setNow(1_000 + RELAY_JOB_TTL_MS)
  const [row] = setup.state.claimUpdates({
    workerId: 'relay-test',
    limit: 1,
    leaseMs: 10_000,
    nowMs: 1_000 + RELAY_JOB_TTL_MS,
  })

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'expired',
  })
  assert.equal(setup.state.getRelayJob('telegram:6'), null)
  assert.equal(setup.state.claimDueOutboundActions({
    workerId: 'probe',
    limit: 10,
    nowMs: 1_000 + RELAY_JOB_TTL_MS,
  }).length, 0)
})

test('queues a human reaction to a known bot message in its original topic', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.createOutboundAction({
    actionId: 'answer:topic',
    conversationKey: '-100123:7',
    actionType: 'reply',
    payload: { text: 'answer' },
    nowMs: 100,
  })
  setup.state.markOutboundSending('answer:topic', 101)
  setup.state.markOutboundSent('answer:topic', {
    telegramChatId: '-100123',
    telegramMessageId: '55',
  }, 102)
  const raw = {
    update_id: 8,
    message_reaction: {
      chat: { id: -100123, type: 'supergroup', title: 'Sandbox' },
      message_id: 55,
      user: { id: 42, is_bot: false, first_name: 'Owner' },
      date: 1,
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    },
  }
  const row = storeAndClaim(setup.state, raw)

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'queued',
  })
  const job = setup.state.getRelayJob('telegram:8')
  assert.equal(job.conversationKey, '-100123:7')
  assert.match(job.payload.text, /Added: 👍/u)
  assert.equal(job.payload.telegramContext.threadId, '7')
  assert.equal(job.payload.telegramContext.senderId, '42')
})

test('resolves a relay approval callback without starting a Codex turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const token = 'approval_callback_token'
  setup.state.createRelayApproval({
    approvalId: 'approval-12345678',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'thread-a',
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-a',
    turnId: 'turn-local',
    ownerUserId: '42',
    detail: 'Command: git push',
    callbackToken: token,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAtMs: 11_000,
    nowMs: 1_000,
  })
  const raw = {
    update_id: 9,
    callback_query: {
      id: 'callback-9',
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      data: `ra:${token}:approve`,
      message: {
        message_id: 90,
        date: 1,
        chat: { id: 42, type: 'private' },
      },
    },
  }
  const row = storeAndClaim(setup.state, raw)

  assert.deepEqual(await setup.dispatcher.processClaimedUpdate(row), {
    status: 'completed',
    action: 'approved',
  })
  assert.equal(setup.state.getRelayApproval('approval-12345678').state, 'approved')
  assert.equal(setup.state.getRelayJob('telegram:9'), null)
  const answer = setup.state.getOutboundAction('relay-callback:9')
  assert.equal(answer.actionType, 'answer_callback_query')
  assert.equal(answer.payload.callbackQueryId, 'callback-9')
})
