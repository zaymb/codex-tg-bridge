import assert from 'node:assert/strict'
import test from 'node:test'

import { TypingPulse } from '../src/typing-pulse.mjs'

class FakeState {
  targets = []

  listAcceptedRelayTypingTargets(sessionLabel, nowMs) {
    assert.equal(sessionLabel, 'tg-engage')
    assert.equal(typeof nowMs, 'number')
    return this.targets
  }
}

class FakeTelegram {
  calls = []
  fail = false

  async sendChatAction(payload) {
    this.calls.push(payload)
    if (this.fail) throw new Error('typing is best effort')
    return true
  }
}

test('pulses every active Telegram turn immediately and at the configured interval', async () => {
  const state = new FakeState()
  const telegram = new FakeTelegram()
  let nowMs = 1_000
  const pulse = new TypingPulse({
    stateStore: state,
    telegramClient: telegram,
    sessionLabel: 'tg-engage',
    intervalMs: 4_000,
    clock: () => nowMs,
  })

  assert.equal(await pulse.drainOnce(), 0)
  state.targets = [
    { conversationKey: '-1001:7', chatId: '-1001', threadId: '7', turnId: 'turn-a' },
    { conversationKey: '42', chatId: '42', threadId: null, turnId: 'turn-a' },
  ]
  assert.equal(await pulse.drainOnce(), 2)
  assert.deepEqual(telegram.calls, [
    { chatId: '-1001', action: 'typing', threadId: '7' },
    { chatId: '42', action: 'typing', threadId: null },
  ])

  nowMs = 4_999
  assert.equal(await pulse.drainOnce(), 0)
  nowMs = 5_000
  assert.equal(await pulse.drainOnce(), 2)
  assert.equal(telegram.calls.length, 4)
})

test('a new turn pulses immediately and stale turns are forgotten', async () => {
  const state = new FakeState()
  const telegram = new FakeTelegram()
  let nowMs = 1_000
  const pulse = new TypingPulse({
    stateStore: state,
    telegramClient: telegram,
    sessionLabel: 'tg-engage',
    intervalMs: 4_000,
    clock: () => nowMs,
  })

  state.targets = [{ conversationKey: '42', chatId: '42', threadId: null, turnId: 'turn-a' }]
  assert.equal(await pulse.drainOnce(), 1)

  nowMs = 1_100
  state.targets = []
  assert.equal(await pulse.drainOnce(), 0)
  state.targets = [{ conversationKey: '42', chatId: '42', threadId: null, turnId: 'turn-b' }]
  assert.equal(await pulse.drainOnce(), 1)
  assert.equal(telegram.calls.length, 2)
})

test('typing failures are best effort and retry only after the interval', async () => {
  const state = new FakeState()
  const telegram = new FakeTelegram()
  let nowMs = 1_000
  const pulse = new TypingPulse({
    stateStore: state,
    telegramClient: telegram,
    sessionLabel: 'tg-engage',
    intervalMs: 4_000,
    clock: () => nowMs,
  })
  state.targets = [{ conversationKey: '42', chatId: '42', threadId: null, turnId: 'turn-a' }]
  telegram.fail = true

  assert.equal(await pulse.drainOnce(), 1)
  nowMs = 1_001
  assert.equal(await pulse.drainOnce(), 0)
  nowMs = 5_000
  assert.equal(await pulse.drainOnce(), 1)
  assert.equal(telegram.calls.length, 2)
})
