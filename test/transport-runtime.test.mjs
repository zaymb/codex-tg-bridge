import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTransportRuntime } from '../src/transport-runtime.mjs'

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('starts transport-only without a Codex app-server and seeds the relay session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tg-transport-runtime-'))
  const methods = []
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    sessionLabel: 'tg-engage',
    dbPath: join(root, 'bridge.sqlite3'),
    pollTimeoutSec: 50,
    updateLeaseMs: 120_000,
    readTelegramToken: () => '123456:test-token',
  }
  const fetchImpl = async url => {
    const method = url.split('/').at(-1)
    methods.push(method)
    if (method === 'getMe') {
      return jsonResponse({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot' } })
    }
    if (method === 'getWebhookInfo') return jsonResponse({ ok: true, result: { url: '' } })
    throw new Error(`unexpected Telegram method: ${method}`)
  }

  const runtime = await createTransportRuntime({ config, fetchImpl })
  t.after(() => runtime.close())

  assert.deepEqual(methods.sort(), ['getMe', 'getWebhookInfo'])
  assert.equal(runtime.bot.username, 'bridge_bot')
  assert.equal(runtime.stateStore.getRelaySession('tg-engage').status, 'offline')
  assert.equal(runtime.stateStore.getApprovedChatByAlias('owner').telegramChatId, '42')
  assert.equal('appServerClient' in runtime, false)
})

test('routes ordinary approved human group messages when passthrough is enabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tg-transport-passthrough-'))
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(['-100123']),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    sessionLabel: 'tg-engage',
    dbPath: join(root, 'bridge.sqlite3'),
    pollTimeoutSec: 50,
    updateLeaseMs: 120_000,
    deliverAllGroupMessages: true,
    readTelegramToken: () => '123456:test-token',
  }
  const fetchImpl = async url => {
    const method = url.split('/').at(-1)
    if (method === 'getMe') {
      return jsonResponse({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot' } })
    }
    if (method === 'getWebhookInfo') return jsonResponse({ ok: true, result: { url: '' } })
    throw new Error(`unexpected Telegram method: ${method}`)
  }
  const runtime = await createTransportRuntime({ config, fetchImpl })
  t.after(() => runtime.close())
  const raw = {
    update_id: 10,
    message: {
      message_id: 100,
      date: 1,
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 99, is_bot: false, first_name: 'Human' },
      text: 'ordinary group message',
    },
  }
  runtime.stateStore.storeUpdate({
    updateId: '10',
    raw,
    normalizedType: 'message',
    conversationKey: '-100123',
    nowMs: Date.now(),
  })

  assert.equal((await runtime.dispatcher.drainOnce()).processed, 1)
  assert.equal(runtime.stateStore.getRelayJob('telegram:10').status, 'pending')
})
