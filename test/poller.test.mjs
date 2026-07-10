import assert from 'node:assert/strict'
import test from 'node:test'

import { Poller } from '../src/poller.mjs'
import { StateStore } from '../src/state-store.mjs'
import { DuplicatePollerError, RateLimitError, TelegramTransportError } from '../src/telegram-client.mjs'

test('stores every update before exposing the next poll offset', async t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  const calls = []
  const telegram = {
    async getUpdates(options) {
      calls.push(options)
      return [
        { update_id: 10, message: { message_id: 1, date: 1, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Owner' }, text: 'one' } },
        { update_id: 11, business_connection: { id: 'unsupported' } },
      ]
    },
  }
  const poller = new Poller({ telegramClient: telegram, stateStore: state, pollTimeoutSec: 50 })

  const result = await poller.pollOnce()

  assert.deepEqual(calls, [{ offset: null, timeoutSec: 50, signal: undefined }])
  assert.deepEqual(result, { received: 2, inserted: 2, pollOffset: '12' })
  assert.equal(state.getUpdate('10').normalizedType, 'message')
  assert.equal(state.getUpdate('10').conversationKey, '42')
  assert.equal(state.getUpdate('11').normalizedType, 'unknown')
})

test('makes duplicate Telegram deliveries local no-ops', async t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  const telegram = { async getUpdates() { return [{ update_id: 10, business_connection: {} }] } }
  const poller = new Poller({ telegramClient: telegram, stateStore: state })

  assert.equal((await poller.pollOnce()).inserted, 1)
  assert.equal((await poller.pollOnce()).inserted, 0)
  assert.equal(state.getPollOffset(), '11')
})

test('stops immediately on duplicate-poller conflict without sleeping', async () => {
  const state = StateStore.open(':memory:')
  const sleeps = []
  const fatal = new DuplicatePollerError('duplicate', { method: 'getUpdates', code: 409 })
  const telegram = { async getUpdates() { throw fatal } }
  const poller = new Poller({ telegramClient: telegram, stateStore: state, sleep: ms => sleeps.push(ms) })

  await assert.rejects(poller.run(), error => error === fatal)
  assert.deepEqual(sleeps, [])
  state.close()
})

test('honors retry_after and retries polling', async t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  let calls = 0
  const sleeps = []
  const controller = new AbortController()
  const telegram = {
    async getUpdates() {
      calls += 1
      if (calls === 1) {
        throw new RateLimitError('limited', {
          method: 'getUpdates',
          code: 429,
          parameters: { retry_after: 3 },
        })
      }
      controller.abort()
      return []
    },
  }
  const poller = new Poller({
    telegramClient: telegram,
    stateStore: state,
    sleep: async ms => { sleeps.push(ms) },
    jitter: () => 125,
  })

  await poller.run({ signal: controller.signal })
  assert.deepEqual(sleeps, [3_125])
  assert.equal(calls, 2)
})

test('uses bounded exponential backoff for transport errors', async t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  let calls = 0
  const sleeps = []
  const controller = new AbortController()
  const telegram = {
    async getUpdates() {
      calls += 1
      if (calls <= 2) throw new TelegramTransportError('offline', { method: 'getUpdates' })
      controller.abort()
      return []
    },
  }
  const poller = new Poller({
    telegramClient: telegram,
    stateStore: state,
    sleep: async ms => { sleeps.push(ms) },
    jitter: () => 0,
  })

  await poller.run({ signal: controller.signal })
  assert.deepEqual(sleeps, [1_000, 2_000])
})
