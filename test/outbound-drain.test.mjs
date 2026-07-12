import assert from 'node:assert/strict'
import test from 'node:test'

import { OutboundDrain } from '../src/outbound-drain.mjs'
import { StateStore } from '../src/state-store.mjs'
import { RateLimitError, TelegramTransportError } from '../src/telegram-client.mjs'

class FakeTelegram {
  calls = []
  failure = null

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

  async react(payload) {
    this.calls.push({ method: 'react', payload })
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

function queueReply(state, actionId = 'reply:1') {
  state.createOutboundAction({
    actionId,
    conversationKey: '42',
    actionType: 'reply',
    payload: { chatId: '42', messageId: '10', text: 'hello' },
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
