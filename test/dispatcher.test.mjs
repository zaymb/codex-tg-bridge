import assert from 'node:assert/strict'
import test from 'node:test'

import { Dispatcher } from '../src/dispatcher.mjs'
import { EngagementPolicy } from '../src/engagement-policy.mjs'
import { StateStore } from '../src/state-store.mjs'
import { RateLimitError, TelegramTransportError } from '../src/telegram-client.mjs'

function rawMessage(updateId, {
  chatId = 42,
  chatType = 'private',
  senderId = 42,
  senderIsBot = false,
  text = 'hello',
  threadId = null,
  photo = null,
} = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      ...(threadId === null ? {} : { message_thread_id: threadId }),
      date: 1,
      chat: { id: chatId, type: chatType, ...(threadId === null ? {} : { is_forum: true }) },
      from: { id: senderId, is_bot: senderIsBot, first_name: senderIsBot ? 'Bot' : 'Human' },
      text,
      ...(photo ? { photo } : {}),
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

class FakeTelegram {
  calls = []
  failNextReply = null

  async sendChatAction(payload) {
    this.calls.push({ method: 'sendChatAction', payload })
    return true
  }

  async reply(payload) {
    this.calls.push({ method: 'reply', payload })
    if (this.failNextReply) {
      const error = this.failNextReply
      this.failNextReply = null
      throw error
    }
    return { message_id: 900 + this.calls.length, chat: { id: payload.chatId } }
  }

  async sendText(payload) {
    this.calls.push({ method: 'sendText', payload })
    return { message_id: 900 + this.calls.length, chat: { id: payload.chatId } }
  }

  async downloadFile(fileId) {
    this.calls.push({ method: 'downloadFile', payload: { fileId } })
    return { filePath: 'photos/file.jpg', bytes: Buffer.from('image'), metadata: { file_id: fileId } }
  }
}

class FakeRunner {
  jobs = []
  interrupts = []
  result = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    finalText: 'final answer',
    skipped: false,
    reason: 'reply',
    sentActionIds: [],
    contextBreak: false,
    replacedThreadId: null,
  }

  async runTurn(job) {
    this.jobs.push(job)
    return { ...this.result }
  }

  async interrupt(key) {
    this.interrupts.push(key)
    return true
  }
}

class FakeAttachmentStore {
  saves = []

  async save(input) {
    this.saves.push(input)
    return {
      created: true,
      localPath: `/srv/codex-inbox/${input.updateId}/photo.jpg`,
      byteSize: input.bytes.length,
      sha256: 'a'.repeat(64),
    }
  }
}

function fixture(overrides = {}) {
  const state = overrides.state ?? StateStore.open(':memory:')
  const telegram = overrides.telegram ?? new FakeTelegram()
  const runner = overrides.runner ?? new FakeRunner()
  const attachmentStore = overrides.attachmentStore ?? new FakeAttachmentStore()
  const callbacks = []
  const approvalRouter = overrides.approvalRouter ?? {
    async handleCallback(update) { callbacks.push(update); return true },
    async expirePending() { return 0 },
  }
  let now = overrides.nowMs ?? 1_000
  const dispatcher = new Dispatcher({
    stateStore: state,
    telegramClient: telegram,
    codexRunner: runner,
    approvalRouter,
    engagementPolicy: overrides.engagementPolicy ?? policy(),
    attachmentStore,
    ownerUserId: '42',
    maxConcurrentTurns: overrides.maxConcurrentTurns ?? 2,
    workerId: 'test-worker',
    updateLeaseMs: 10_000,
    typingIntervalMs: 60_000,
    clock: () => now,
  })
  return { state, telegram, runner, attachmentStore, approvalRouter, callbacks, dispatcher, setNow: value => { now = value } }
}

function storeAndClaim(state, raw, nowMs = 1_000) {
  state.storeUpdate({
    updateId: String(raw.update_id),
    raw,
    normalizedType: raw.message_reaction ? 'message_reaction' : raw.callback_query ? 'callback_query' : 'message',
    nowMs,
  })
  return state.claimUpdates({ workerId: 'test-worker', limit: 1, leaseMs: 10_000, nowMs })[0]
}

test('runs an owner-DM turn and records the automatic final reply once', async t => {
  const { state, telegram, runner, dispatcher } = fixture()
  t.after(() => state.close())
  const row = storeAndClaim(state, rawMessage(1))

  const result = await dispatcher.processClaimedUpdate(row)

  assert.equal(result.status, 'completed')
  assert.equal(state.getUpdate('1').status, 'completed')
  assert.equal(runner.jobs[0].conversationKey, '42')
  assert.equal(runner.jobs[0].ownerDm, true)
  assert.equal(telegram.calls.filter(call => call.method === 'reply').length, 1)
  const outbound = state.getOutboundAction('answer:update:1:0000')
  assert.equal(outbound.status, 'sent')
  assert.equal(outbound.conversationKey, '42')
})

test('does not send an automatic answer for structured SKIP or an equivalent Telegram tool action', async t => {
  const skipped = fixture()
  t.after(() => skipped.state.close())
  skipped.runner.result = { ...skipped.runner.result, skipped: true, finalText: null }
  await skipped.dispatcher.processClaimedUpdate(storeAndClaim(skipped.state, rawMessage(2)))
  assert.equal(skipped.telegram.calls.some(call => ['reply', 'sendText'].includes(call.method)), false)

  const toolSent = fixture()
  t.after(() => toolSent.state.close())
  toolSent.state.createOutboundAction({
    actionId: 'tool-action-1',
    conversationKey: '42',
    actionType: 'send_text',
    payload: { chatId: '42', text: 'sent by tool' },
    nowMs: 900,
  })
  toolSent.state.markOutboundSending('tool-action-1', 900)
  toolSent.state.markOutboundSent('tool-action-1', { telegramChatId: '42', telegramMessageId: '99' }, 901)
  toolSent.runner.result = { ...toolSent.runner.result, sentActionIds: ['tool-action-1'] }
  await toolSent.dispatcher.processClaimedUpdate(storeAndClaim(toolSent.state, rawMessage(3)))
  assert.equal(toolSent.telegram.calls.some(call => ['reply', 'sendText'].includes(call.method)), false)
})

test('handles /new, /stop, and approval callbacks without a Codex turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.upsertConversation({ conversationKey: '42', threadId: 'old-thread', nowMs: 1 })

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(4, { text: '/new' })))
  assert.equal(setup.state.getConversation('42').threadId, null)

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(5, { text: '/stop' })))
  assert.deepEqual(setup.runner.interrupts, ['42'])

  const callbackRaw = {
    update_id: 6,
    callback_query: {
      id: 'callback-1',
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      data: 'ap:opaque-token:approve',
      message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' } },
    },
  }
  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, callbackRaw))

  assert.equal(setup.runner.jobs.length, 0)
  assert.equal(setup.callbacks.length, 1)
})

test('downloads approved attachments before starting the turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  const raw = rawMessage(7, {
    photo: [{ file_id: 'photo-file', file_unique_id: 'unique', width: 10, height: 10, file_size: 5 }],
  })

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw))

  assert.equal(setup.attachmentStore.saves.length, 1)
  assert.equal(setup.runner.jobs[0].attachments[0].localPath, '/srv/codex-inbox/7/photo.jpg')
  assert.equal(setup.state.getAttachmentByFileId('photo-file').localPath, '/srv/codex-inbox/7/photo.jpg')
})

test('routes a reaction back to the original bot message topic', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.createOutboundAction({
    actionId: 'prior-answer',
    conversationKey: '-100123:7',
    actionType: 'reply',
    payload: { chatId: '-100123', messageId: '55', text: 'prior' },
    nowMs: 100,
  })
  setup.state.markOutboundSending('prior-answer', 100)
  setup.state.markOutboundSent('prior-answer', { telegramChatId: '-100123', telegramMessageId: '55' }, 101)
  const raw = {
    update_id: 8,
    message_reaction: {
      chat: { id: -100123, type: 'supergroup' },
      message_id: 55,
      date: 1,
      user: { id: 99, is_bot: false, first_name: 'Human' },
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    },
  }

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, raw))

  assert.equal(setup.runner.jobs[0].conversationKey, '-100123:7')
  assert.match(setup.runner.jobs[0].text, /reaction/)
})

test('marks uncertain sends ambiguous and completes the source update without retrying Codex', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.telegram.failNextReply = new TelegramTransportError('connection reset', {
    method: 'sendMessage',
    deliveryAmbiguous: true,
  })

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(9)))

  assert.equal(setup.state.getUpdate('9').status, 'completed')
  assert.equal(setup.state.getOutboundAction('answer:update:9:0000').status, 'ambiguous')
  assert.equal(setup.runner.jobs.length, 1)
})

test('defers a rate-limited outbound action and retries it without another Codex turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.telegram.failNextReply = new RateLimitError('limited', {
    method: 'sendMessage',
    code: 429,
    parameters: { retry_after: 3 },
  })

  await setup.dispatcher.processClaimedUpdate(storeAndClaim(setup.state, rawMessage(10)))
  assert.equal(setup.state.getUpdate('10').status, 'completed')
  assert.equal(setup.state.getOutboundAction('answer:update:10:0000').status, 'failed')
  assert.equal(setup.state.getOutboundAction('answer:update:10:0000').nextAttemptAtMs, 4_000)

  setup.setNow(4_000)
  assert.equal(await setup.dispatcher.drainOutboundOnce(), 1)
  assert.equal(setup.state.getOutboundAction('answer:update:10:0000').status, 'sent')
  assert.equal(setup.runner.jobs.length, 1)
})

test('serializes one topic while allowing different topics up to the global limit', async t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  const telegram = new FakeTelegram()
  const activeByKey = new Map()
  let globalActive = 0
  let maxGlobal = 0
  let sameKeyOverlap = false
  const runner = {
    async runTurn(job) {
      const active = (activeByKey.get(job.conversationKey) ?? 0) + 1
      activeByKey.set(job.conversationKey, active)
      if (active > 1) sameKeyOverlap = true
      globalActive += 1
      maxGlobal = Math.max(maxGlobal, globalActive)
      await new Promise(resolve => setTimeout(resolve, 20))
      globalActive -= 1
      activeByKey.set(job.conversationKey, active - 1)
      return { finalText: null, skipped: true, sentActionIds: [], contextBreak: false }
    },
    async interrupt() { return true },
  }
  const setup = fixture({ state, telegram, runner, maxConcurrentTurns: 2 })
  const raws = [
    rawMessage(11, { chatId: -100123, chatType: 'supergroup', senderId: 99, text: '/ask one', threadId: 7 }),
    rawMessage(12, { chatId: -100123, chatType: 'supergroup', senderId: 99, text: '/ask two', threadId: 7 }),
    rawMessage(13, { chatId: -100123, chatType: 'supergroup', senderId: 99, text: '/ask other', threadId: 8 }),
  ]
  for (const raw of raws) {
    state.storeUpdate({ updateId: String(raw.update_id), raw, normalizedType: 'message', nowMs: 1_000 })
  }

  const result = await setup.dispatcher.drainOnce({ limit: 3 })

  assert.equal(result.processed, 3)
  assert.equal(sameKeyOverlap, false)
  assert.equal(maxGlobal, 2)
  assert.ok(['11', '12', '13'].every(id => state.getUpdate(id).status === 'completed'))
})
