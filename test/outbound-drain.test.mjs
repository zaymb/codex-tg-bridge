import assert from 'node:assert/strict'
import test from 'node:test'

import { OutboundDrain } from '../src/outbound-drain.mjs'
import { StateStore } from '../src/state-store.mjs'
import { RateLimitError, TelegramApiError, TelegramTransportError } from '../src/telegram-client.mjs'

class FakeTelegram {
  calls = []
  failure = null
  reactionFailure = null

  async reply(payload) {
    this.calls.push({ method: 'reply', payload })
    if (this.failure) {
      const error = this.failure
      this.failure = null
      throw error
    }
    return { message_id: 901, chat: { id: payload.chatId } }
  }

  async sendText(payload) {
    this.calls.push({ method: 'sendText', payload })
    return { message_id: 902, chat: { id: payload.chatId } }
  }

  async sendDice(payload) {
    this.calls.push({ method: 'sendDice', payload })
    return { message_id: 903, chat: { id: payload.chatId }, dice: { emoji: payload.emoji, value: 4 } }
  }

  async react(payload) {
    this.calls.push({ method: 'react', payload })
    if (this.reactionFailure) {
      const error = this.reactionFailure
      this.reactionFailure = null
      throw error
    }
    return true
  }

  async answerCallbackQuery(payload) {
    this.calls.push({ method: 'answerCallbackQuery', payload })
    return true
  }
}

function fixture() {
  const state = StateStore.open(':memory:')
  const telegram = new FakeTelegram()
  let now = 1_000
  const drain = new OutboundDrain({
    stateStore: state,
    telegramClient: telegram,
    workerId: 'outbound-test',
    clock: () => now,
    botIdentity: { id: '500', username: 'bridge_bot' },
  })
  return { state, telegram, drain, setNow(value) { now = value } }
}

function queueReply(state, actionId = 'reply:1', payloadOverrides = {}) {
  state.createOutboundAction({
    actionId,
    conversationKey: '42',
    actionType: 'reply',
    payload: { chatId: '42', messageId: '10', text: 'hello', ...payloadOverrides },
    nowMs: 1_000,
  })
}

test('sends a durable outbound action and records Telegram message identity', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  queueReply(setup.state)

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.equal(setup.telegram.calls.length, 1)
  assert.equal(setup.state.getOutboundAction('reply:1').status, 'sent')
  assert.equal(setup.state.getOutboundAction('reply:1').telegramMessageId, '901')
})

test('captures a successful outbound bot reaction for side-channel consumers', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.createOutboundAction({
    actionId: 'react:1',
    conversationKey: '-100123',
    actionType: 'react',
    payload: {
      chatId: '-100123',
      messageId: '55',
      reaction: { type: 'emoji', emoji: '👍' },
    },
    nowMs: 1_000,
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.equal(setup.state.getOutboundAction('react:1').status, 'sent')
  assert.deepEqual(setup.state.listBotReactionEvents({ afterEventId: 0 }).map(event => ({
    actionId: event.actionId,
    botId: event.botId,
    messageId: event.messageId,
    reaction: event.reaction,
    extendsCooldown: event.extendsCooldown,
  })), [{
    actionId: 'react:1',
    botId: '500',
    messageId: '55',
    reaction: { type: 'emoji', emoji: '👍' },
    extendsCooldown: false,
  }])
})

test('does not turn a rejected reaction into a visible emoji reply', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.telegram.reactionFailure = new TelegramApiError(
    'Telegram setMessageReaction failed (400): Bad Request: REACTION_INVALID',
    { method: 'setMessageReaction', code: 400 },
  )
  setup.state.createOutboundAction({
    actionId: 'react:invalid',
    conversationKey: '-100123:99',
    actionType: 'react',
    payload: {
      chatId: '-100123',
      threadId: '99',
      messageId: '55',
      reaction: { type: 'emoji', emoji: '✅' },
    },
    nowMs: 1_000,
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.deepEqual(setup.telegram.calls, [{
    method: 'react',
    payload: {
      chatId: '-100123',
      threadId: '99',
      messageId: '55',
      reaction: { type: 'emoji', emoji: '✅' },
    },
  }])
  const action = setup.state.getOutboundAction('react:invalid')
  assert.equal(action.status, 'failed')
  assert.equal(action.actionType, 'react')
  assert.match(action.lastError, /REACTION_INVALID/u)
  assert.equal(action.telegramMessageId, null)
  assert.deepEqual(setup.state.listBotReactionEvents({ afterEventId: 0 }), [])
})

test('sends and records a durable Telegram dice action', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.createOutboundAction({
    actionId: 'dice:1',
    conversationKey: '-100123',
    actionType: 'send_dice',
    payload: { chatId: '-100123', emoji: '🎲', replyToMessageId: '55' },
    nowMs: 1_000,
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.deepEqual(setup.telegram.calls, [{
    method: 'sendDice',
    payload: { chatId: '-100123', emoji: '🎲', replyToMessageId: '55' },
  }])
  assert.equal(setup.state.getOutboundAction('dice:1').telegramMessageId, '903')
})

test('answers an approval callback through the durable outbox', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  setup.state.createOutboundAction({
    actionId: 'callback:1',
    conversationKey: '42',
    actionType: 'answer_callback_query',
    payload: { callbackQueryId: 'callback-1', text: 'Approved', showAlert: false },
    nowMs: 1_000,
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.deepEqual(setup.telegram.calls, [{
    method: 'answerCallbackQuery',
    payload: { callbackQueryId: 'callback-1', text: 'Approved', showAlert: false },
  }])
})

test('defers rate limits and does not retry ambiguous deliveries', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  queueReply(setup.state, 'limited')
  setup.telegram.failure = new RateLimitError('limited', {
    method: 'sendMessage',
    code: 429,
    parameters: { retry_after: 3 },
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  assert.equal(setup.state.getOutboundAction('limited').nextAttemptAtMs, 4_000)
  setup.setNow(4_000)
  assert.equal(await setup.drain.drainOnce(), 1)
  assert.equal(setup.state.getOutboundAction('limited').status, 'sent')

  queueReply(setup.state, 'ambiguous')
  setup.telegram.failure = new TelegramTransportError('connection reset', {
    method: 'sendMessage',
    deliveryAmbiguous: true,
  })
  assert.equal(await setup.drain.drainOnce(), 1)
  assert.equal(setup.state.getOutboundAction('ambiguous').status, 'ambiguous')
  assert.equal(await setup.drain.drainOnce(), 0)
})

test('does not retry a rate-limited progress update after the final can exist', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  queueReply(setup.state, 'progress:1', { deliveryClass: 'progress' })
  setup.telegram.failure = new RateLimitError('limited', {
    method: 'sendMessage',
    code: 429,
    parameters: { retry_after: 3 },
  })

  assert.equal(await setup.drain.drainOnce(), 1)
  const action = setup.state.getOutboundAction('progress:1')
  assert.equal(action.status, 'failed')
  assert.equal(action.nextAttemptAtMs, null)
  setup.setNow(4_000)
  assert.equal(await setup.drain.drainOnce(), 0)
})
