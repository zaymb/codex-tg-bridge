import assert from 'node:assert/strict'
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
    allowedChatIds: new Set(['-100123']),
    allowedChannelIds: new Set(),
  }, { botUserId: '500', botUsername: 'bridge_bot' })
}

function fixture() {
  const state = StateStore.open(':memory:')
  let now = 1_000
  const dispatcher = new RelayDispatcher({
    stateStore: state,
    engagementPolicy: policy(),
    sessionLabel: 'tg-engage',
    workerId: 'relay-test',
    updateLeaseMs: 10_000,
    clock: () => now,
  })
  return { state, dispatcher, setNow(value) { now = value } }
}

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
