import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EngagementPolicy } from '../src/engagement-policy.mjs'
import { RelayDispatcher } from '../src/relay-dispatcher.mjs'
import { StateStore } from '../src/state-store.mjs'
import { createTransportRuntime } from '../src/transport-runtime.mjs'
import {
  AWAY_ACK_PREFIX,
  AWAY_INVALID_PREFIX,
  AWAY_INVALID_REPLY,
  DISENGAGE_ACK_PREFIX,
  DISENGAGE_REPLY,
  INTERRUPT_ACK_PREFIX,
  INTERRUPT_REPLY,
  RESUME_ACK_PREFIX,
  RESUME_REPLY,
  TransportControl,
} from '../src/transport-control.mjs'

function rawMessage(updateId, {
  text = 'hello',
  senderId = 42,
  chatId = 42,
  chatType = 'private',
  threadId = null,
} = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1,
      chat: { id: chatId, type: chatType },
      from: { id: senderId, is_bot: false, first_name: 'Owner' },
      text,
      ...(threadId === null ? {} : { message_thread_id: threadId }),
    },
  }
}

function fixture() {
  const state = StateStore.open(':memory:')
  let now = 1_000
  const clock = () => now
  const control = new TransportControl({ stateStore: state, clock })
  const dispatcher = new RelayDispatcher({
    stateStore: state,
    engagementPolicy: new EngagementPolicy({
      ownerUserId: '42',
      allowedChatIds: new Set(),
      allowedChannelIds: new Set(),
    }, { botUserId: '500', botUsername: 'bridge_bot' }),
    sessionLabel: 'tg-engage',
    ownerUserId: '42',
    workerId: 'relay-test',
    updateLeaseMs: 10_000,
    clock,
    transportControl: control,
    botUsername: 'bridge_bot',
  })
  const seed = (updateId, options) => state.storeUpdate({
    updateId: String(updateId),
    raw: rawMessage(updateId, options),
    normalizedType: 'message',
    nowMs: now,
  })
  return { state, control, dispatcher, seed, tick: ms => { now += ms } }
}

test('/away arms pending, acks once, and leaves ordinary traffic queued', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/away 15m' })
  let result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 1)

  const ack = state.getOutboundAction(`${AWAY_ACK_PREFIX}11`)
  assert.equal(ack.payload.text, 'Will be back in 15m.')
  assert.equal(control.read().away.phase, 'pending')
  assert.equal(state.getRelayJob('telegram:11'), null, 'command must never become a relay job')

  // Ordinary messages during away stay durably queued — no claims, no jobs.
  seed(12, { text: 'first while away' })
  seed(13, { text: 'second while away' })
  result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 0)
  assert.equal(state.countQueuedUpdates(), 2)
  assert.equal(state.getRelayJob('telegram:12'), null)
})

test('admin @bot mention releases away and flushes the backlog once, in order', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/away 15m' })
  await dispatcher.drainOnce()
  control.handleAckSent(`${AWAY_ACK_PREFIX}11`, 2_000)

  seed(12, { text: 'first while away' })
  seed(13, { text: 'second while away' })
  seed(14, { text: '@bridge_bot 醒醒' })

  // The release pass claims only the mention, clears away, and requeues it.
  let result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 1)
  assert.equal(control.isAway(2_000), false)
  assert.equal(state.countQueuedUpdates(), 3, 'mention returns to the queue for the normal pipeline')

  // The very next normal drain moves the whole backlog into relay jobs.
  result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 3)
  for (const updateId of ['12', '13', '14']) {
    assert.ok(state.getRelayJob(`telegram:${updateId}`), `relay job for update ${updateId}`)
  }
  const jobs = ['12', '13', '14'].map(id => state.getRelayJob(`telegram:${id}`))
  assert.ok(jobs[0].createdAtMs <= jobs[1].createdAtMs && jobs[1].createdAtMs <= jobs[2].createdAtMs)
})

test('a non-admin mention never releases away', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/away 15m' })
  await dispatcher.drainOnce()
  control.handleAckSent(`${AWAY_ACK_PREFIX}11`, 2_000)

  seed(12, { text: '@bridge_bot hello', senderId: 77 })
  const result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 0)
  assert.equal(control.isAway(2_000), true)
})

test('away expiry reopens the pipeline without any command', async t => {
  const { state, control, dispatcher, seed, tick } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/away 1m' })
  await dispatcher.drainOnce()
  control.handleAckSent(`${AWAY_ACK_PREFIX}11`, 1_000)
  seed(12, { text: 'queued during away' })
  assert.equal((await dispatcher.drainOnce()).claimed, 0)

  tick(61_000)
  const result = await dispatcher.drainOnce()
  assert.equal(result.claimed, 1)
  assert.ok(state.getRelayJob('telegram:12'))
  assert.equal(control.read().away, null)
})

test('malformed /away gets the fixed error reply and never reaches the model', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/away 90m' })
  await dispatcher.drainOnce()
  const reply = state.getOutboundAction(`${AWAY_INVALID_PREFIX}11`)
  assert.equal(reply.payload.text, AWAY_INVALID_REPLY)
  assert.equal(control.read().away, null)
  assert.equal(state.getRelayJob('telegram:11'), null)
})

test('/disengage stops fresh intake immediately, even while pending', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(11, { text: '/disengage' })
  await dispatcher.drainOnce()
  assert.equal(state.getOutboundAction(`${DISENGAGE_ACK_PREFIX}11`).payload.text, DISENGAGE_REPLY)
  assert.equal(control.isDisengagePending(), true)

  seed(12, { text: 'should stay queued forever' })
  assert.equal((await dispatcher.drainOnce()).claimed, 0)

  control.handleAckSent(`${DISENGAGE_ACK_PREFIX}11`, 2_000)
  assert.equal(control.isDisengaged(), true)
  assert.equal((await dispatcher.drainOnce()).claimed, 0)
  assert.equal(state.getRelayJob('telegram:12'), null)
})

test('admin group /stop bypasses model policy and queues an out-of-band interrupt', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(17, {
    text: '/stop',
    chatId: -100123,
    chatType: 'supergroup',
    threadId: 7,
  })
  const result = await dispatcher.drainOnce()

  assert.equal(result.processed, 1)
  assert.equal(state.getOutboundAction(`${INTERRUPT_ACK_PREFIX}17`).payload.text, INTERRUPT_REPLY)
  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'interrupt:17',
    conversationKey: '-100123:7',
    requestedAtMs: 1_000,
  })
  assert.equal(state.getRelayJob('telegram:17'), null)
})

test('admin group /stop elio queues an Elio-only interrupt and receipt', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(19, {
    text: '/stop elio',
    chatId: -100123,
    chatType: 'supergroup',
    threadId: 7,
  })
  const result = await dispatcher.drainOnce()

  assert.equal(result.processed, 1)
  assert.equal(state.getOutboundAction(`${INTERRUPT_ACK_PREFIX}19`).payload.text, 'Elio stopped.')
  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'interrupt:19',
    conversationKey: '-100123:7',
    target: 'elio',
    requestedAtMs: 1_000,
  })
})

test('admin group /stop laurie queues a Laurie-only interrupt without impersonating its receipt', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(20, {
    text: '/stop laurie',
    chatId: -100123,
    chatType: 'supergroup',
    threadId: 7,
  })
  await dispatcher.drainOnce()

  assert.equal(state.getOutboundAction(`${INTERRUPT_ACK_PREFIX}20`), null)
  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'interrupt:20',
    conversationKey: '-100123:7',
    target: 'laurie',
    requestedAtMs: 1_000,
  })
})

test('admin group continue bypasses model policy and queues an out-of-band resume', async t => {
  const { state, control, dispatcher, seed } = fixture()
  t.after(() => state.close())

  seed(18, {
    text: 'continue',
    chatId: -100123,
    chatType: 'supergroup',
    threadId: 7,
  })
  const result = await dispatcher.drainOnce()

  assert.equal(result.processed, 1)
  assert.equal(state.getOutboundAction(`${RESUME_ACK_PREFIX}18`).payload.text, RESUME_REPLY)
  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'resume:18',
    conversationKey: '-100123:7',
    action: 'continue',
    requestedAtMs: 1_000,
  })
  assert.equal(state.getRelayJob('telegram:18'), null)
})

test('runtime quiesces and leaves via DisengagedError after a confirmed farewell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tg-transport-disengage-'))
  const dbPath = join(root, 'bridge.sqlite3')

  const seedStore = StateStore.open(dbPath)
  seedStore.storeUpdate({
    updateId: '21',
    raw: rawMessage(21, { text: '/disengage' }),
    normalizedType: 'message',
    nowMs: 500,
  })
  seedStore.close()

  const sends = []
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1)
    const jsonResponse = body => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    if (method === 'getMe') {
      return jsonResponse({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot' } })
    }
    if (method === 'getWebhookInfo') return jsonResponse({ ok: true, result: { url: '' } })
    if (method === 'getUpdates') {
      await new Promise(resolve => setTimeout(resolve, 25))
      return jsonResponse({ ok: true, result: [] })
    }
    if (method === 'sendMessage') {
      sends.push(JSON.parse(options.body).text)
      return jsonResponse({ ok: true, result: { message_id: 777, chat: { id: 42 } } })
    }
    throw new Error(`unexpected Telegram method: ${method}`)
  }

  const runtime = await createTransportRuntime({
    config: {
      ownerUserId: '42',
      allowedChatIds: new Set(),
      allowedChannelIds: new Set(),
      chatAliases: new Map(),
      sessionLabel: 'tg-engage',
      dbPath,
      pollTimeoutSec: 1,
      updateLeaseMs: 120_000,
      readTelegramToken: () => '123456:test-token',
    },
    fetchImpl,
    workerIdleMs: 10,
  })

  await assert.rejects(runtime.run(), { name: 'DisengagedError' })
  assert.deepEqual(sends, [DISENGAGE_REPLY], 'exactly one confirmed farewell before leaving')

  // The active disengage must have survived on disk (run() closed the store).
  const inspection = StateStore.open(dbPath)
  const inspectionControl = new TransportControl({ stateStore: inspection })
  assert.equal(inspectionControl.isDisengaged(), true)
  assert.equal(inspectionControl.isDisengageReady(), true, 'local disconnect is published only after quiesce')
  inspection.close()

  // A restarted runtime is a tombstone: it must leave the same way without
  // ever polling Telegram again.
  const revived = await createTransportRuntime({
    config: {
      ownerUserId: '42',
      allowedChatIds: new Set(),
      allowedChannelIds: new Set(),
      chatAliases: new Map(),
      sessionLabel: 'tg-engage',
      dbPath,
      pollTimeoutSec: 1,
      updateLeaseMs: 120_000,
      readTelegramToken: () => '123456:test-token',
    },
    fetchImpl: async url => {
      const method = url.split('/').at(-1)
      if (method === 'getUpdates') throw new Error('tombstone must not poll Telegram')
      return fetchImpl(url)
    },
    workerIdleMs: 10,
  })
  await assert.rejects(revived.run(), { name: 'DisengagedError' })
})
