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
