import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ControlClient } from '../src/control-client.mjs'
import { StateStore } from '../src/state-store.mjs'
import { WakeServer } from '../src/wake-server.mjs'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-wake-'))
  const socketPath = join(dir, 'wake.sock')
  const state = StateStore.open(':memory:')
  state.upsertApprovedChat({
    conversationKey: '-100123:7',
    telegramChatId: '-100123',
    alias: 'sandbox-topic',
    title: 'Sandbox Topic',
    kind: 'forum_topic',
    nowMs: 1,
  })
  const server = new WakeServer({
    socketPath,
    stateStore: state,
    allowedSources: new Set(['cron', 'sw', 'manual']),
    clock: () => 1_000,
  })
  await server.start()
  const client = await ControlClient.connect({ socketPath, requestTimeoutMs: 1_000 })
  return { state, server, client }
}

test('persists an approved wake request and deduplicates its source key', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())
  const params = {
    target: 'sandbox-topic',
    source: 'cron',
    reason: 'morning check',
    context: { schedule: 'daily' },
    dedupeKey: 'daily:2026-07-11',
    earliestAtMs: 2_000,
    expiresAtMs: 10_000,
  }

  const first = await setup.client.request('enqueue_wake', params, { actionId: 'wake-request-1' })
  const duplicate = await setup.client.request('enqueue_wake', params, { actionId: 'wake-request-2' })

  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  const wake = setup.state.getWakeByDedupe('cron', 'daily:2026-07-11')
  assert.equal(wake.conversationKey, '-100123:7')
  assert.deepEqual(wake.context, { schedule: 'daily' })
})

test('rejects unapproved wake sources and Telegram targets', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  await assert.rejects(
    setup.client.request('enqueue_wake', {
      target: 'sandbox-topic', source: 'agent', reason: 'recursive', dedupeKey: 'bad', expiresAtMs: 5_000,
    }, { actionId: 'bad-source' }),
    /wake source is not allowed/,
  )
  await assert.rejects(
    setup.client.request('enqueue_wake', {
      target: '-100999', source: 'manual', reason: 'unknown', dedupeKey: 'bad-chat', expiresAtMs: 5_000,
    }, { actionId: 'bad-chat' }),
    /unknown or unapproved Telegram target/,
  )
})
