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
