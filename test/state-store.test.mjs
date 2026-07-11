import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StateStore } from '../src/state-store.mjs'

async function openStore() {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-state-'))
  const path = join(dir, 'bridge.sqlite3')
  return { path, store: StateStore.open(path) }
}

test('opens in WAL mode and applies the current schema once', async t => {
  const { path, store } = await openStore()
  t.after(() => store.close())

  assert.equal(store.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(store.getSetting('schema_version'), '2')

  store.close()
  const reopened = StateStore.open(path)
  t.after(() => reopened.close())
  assert.equal(reopened.getSetting('schema_version'), '2')
})

test('stores an update and advances offset only after durable insertion', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const result = store.storeUpdate({
    updateId: '9007199254740993123',
    raw: { update_id: '9007199254740993123', message: { text: 'hello' } },
    normalizedType: 'message',
    conversationKey: '-1001234567890123456:77',
    nowMs: 1_000,
  })

  assert.deepEqual(result, { inserted: true, pollOffset: '9007199254740993124' })
  assert.equal(store.getPollOffset(), '9007199254740993124')
  assert.deepEqual(store.getUpdate('9007199254740993123').raw, {
    update_id: '9007199254740993123',
    message: { text: 'hello' },
  })
})

test('deduplicates update IDs while retaining the highest durable offset', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const first = store.storeUpdate({ updateId: '41', raw: { update_id: 41 }, normalizedType: 'message', nowMs: 10 })
  const duplicate = store.storeUpdate({ updateId: '41', raw: { update_id: 41, changed: true }, normalizedType: 'edited_message', nowMs: 20 })
  const older = store.storeUpdate({ updateId: '39', raw: { update_id: 39 }, normalizedType: 'message', nowMs: 30 })

  assert.deepEqual(first, { inserted: true, pollOffset: '42' })
  assert.deepEqual(duplicate, { inserted: false, pollOffset: '42' })
  assert.deepEqual(older, { inserted: true, pollOffset: '42' })
  assert.equal(store.getUpdate('41').normalizedType, 'message')
})

test('claims updates with leases and recovers only expired processing rows', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const updateId of ['1', '2']) {
    store.storeUpdate({ updateId, raw: { update_id: updateId }, normalizedType: 'message', nowMs: 100 })
  }

  const claimed = store.claimUpdates({ workerId: 'worker-a', limit: 1, leaseMs: 500, nowMs: 200 })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].updateId, '1')
  assert.equal(claimed[0].attempts, 1)
  assert.equal(store.recoverExpiredLeases(699), 0)
  assert.equal(store.recoverExpiredLeases(700), 1)

  const reclaimed = store.claimUpdates({ workerId: 'worker-b', limit: 2, leaseMs: 500, nowMs: 701 })
  assert.deepEqual(reclaimed.map(row => row.updateId), ['1', '2'])
  assert.equal(reclaimed[0].attempts, 2)
})

test('claims only pending updates selected by a synchronous predicate', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const [updateId, text] of [['1', 'hello'], ['2', '/stop'], ['3', 'later']]) {
    store.storeUpdate({
      updateId,
      raw: { update_id: Number(updateId), message: { text } },
      normalizedType: 'message',
      nowMs: 100,
    })
  }

  const claimed = store.claimUpdatesMatching({
    workerId: 'stop-worker',
    predicate: row => row.raw.message.text === '/stop',
    scanLimit: 10,
    limit: 2,
    leaseMs: 500,
    nowMs: 200,
  })

  assert.deepEqual(claimed.map(row => row.updateId), ['2'])
  assert.equal(store.getUpdate('1').status, 'pending')
  assert.equal(store.getUpdate('2').leaseOwner, 'stop-worker')
})

test('can scan the full pending backlog for an urgent control update', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (let updateId = 1; updateId <= 1_025; updateId += 1) {
    store.storeUpdate({
      updateId: String(updateId),
      raw: { update_id: updateId, message: { text: 'ordinary' } },
      normalizedType: 'message',
      nowMs: 100,
    })
  }
  store.storeUpdate({
    updateId: '1026',
    raw: { update_id: 1026, message: { text: '/stop' } },
    normalizedType: 'message',
    nowMs: 100,
  })

  const claimed = store.claimUpdatesMatching({
    workerId: 'control-worker',
    predicate: row => row.raw.message.text === '/stop',
    scanLimit: null,
    limit: 1,
    nowMs: 200,
  })

  assert.deepEqual(claimed.map(row => row.updateId), ['1026'])
})

test('requires the lease owner to complete or retry an update', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.storeUpdate({ updateId: '5', raw: { update_id: 5 }, normalizedType: 'message', nowMs: 100 })
  store.claimUpdates({ workerId: 'worker-a', leaseMs: 500, nowMs: 200 })

  assert.equal(store.completeUpdate({ updateId: '5', workerId: 'worker-b', nowMs: 250 }), false)
  assert.equal(store.failUpdate({
    updateId: '5',
    workerId: 'worker-a',
    error: 'temporary',
    retryAtMs: 500,
    nowMs: 300,
  }), true)
  assert.equal(store.claimUpdates({ workerId: 'worker-b', nowMs: 499 }).length, 0)
  assert.equal(store.claimUpdates({ workerId: 'worker-b', nowMs: 500 })[0].attempts, 2)
  assert.equal(store.completeUpdate({ updateId: '5', workerId: 'worker-b', nowMs: 550 }), true)
  assert.equal(store.getUpdate('5').status, 'completed')
})

test('keeps conversation settings and clears only the exact active turn', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  store.upsertConversation({
    conversationKey: '-100123:7',
    threadId: 'thread-1',
    effortOverride: 'xhigh',
    nowMs: 100,
  })
  assert.equal(store.setActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-1', nowMs: 110 }), true)
  assert.throws(
    () => store.setActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-2', nowMs: 120 }),
    /already has active turn turn-1/,
  )
  assert.equal(store.clearActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-other', nowMs: 130 }), false)
  assert.equal(store.clearActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-1', nowMs: 140 }), true)

  const detached = store.detachThread('-100123:7', 'stale app-server thread', 150)
  assert.equal(detached, 'thread-1')
  assert.deepEqual(store.getConversation('-100123:7'), {
    conversationKey: '-100123:7',
    threadId: null,
    modelOverride: null,
    effortOverride: 'xhigh',
    activeTurnId: null,
    activeTurnStartedAtMs: null,
    staleReason: 'stale app-server thread',
    updatedAtMs: 150,
  })
})

test('persists the source before turn start and atomically replaces the placeholder', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.upsertConversation({ conversationKey: '42', threadId: 'thread-1', nowMs: 100 })

  assert.equal(store.beginActiveTurn({
    conversationKey: '42',
    placeholderTurnId: 'starting:telegram:77',
    sourceId: 'telegram:77',
    nowMs: 110,
  }), true)
  assert.deepEqual(store.listActiveConversations().map(item => ({
    turnId: item.activeTurnId,
    sourceId: item.activeSourceId,
  })), [{ turnId: 'starting:telegram:77', sourceId: 'telegram:77' }])
  assert.equal(store.replaceActiveTurn({
    conversationKey: '42',
    expectedTurnId: 'starting:telegram:77',
    turnId: 'turn-1',
    nowMs: 120,
  }), true)
  assert.equal(store.listActiveConversations()[0].activeTurnId, 'turn-1')
  assert.equal(store.clearActiveTurn({ conversationKey: '42', turnId: 'turn-1', nowMs: 130 }), true)
  assert.deepEqual(store.listActiveConversations(), [])
})

test('marks a correlated Telegram update or wake permanently failed after an uncertain turn', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.storeUpdate({ updateId: '77', raw: { update_id: 77 }, normalizedType: 'message', nowMs: 1 })
  store.claimUpdates({ workerId: 'worker', nowMs: 2 })
  const wake = store.enqueueWake({
    conversationKey: '42',
    source: 'manual',
    reason: 'test',
    dedupeKey: 'wake-1',
    earliestAtMs: 1,
    expiresAtMs: 10_000,
    nowMs: 1,
  }).wake
  store.claimWakes({ workerId: 'worker', nowMs: 2 })

  assert.equal(store.failUncertainSource('telegram:77', 'turn outcome unknown', 100), true)
  assert.equal(store.getUpdate('77').status, 'failed')
  assert.match(store.getUpdate('77').lastError, /outcome unknown/)
  assert.equal(store.failUncertainSource(`wake:${wake.id}`, 'turn outcome unknown', 100), true)
  assert.equal(store.getWake(wake.id).status, 'failed')
})

test('deduplicates outbound actions and preserves ambiguous sends', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const first = store.createOutboundAction({
    actionId: 'answer:update:42',
    conversationKey: '-100123',
    actionType: 'send_text',
    payload: { text: 'hello' },
    nowMs: 100,
  })
  const duplicate = store.createOutboundAction({
    actionId: 'answer:update:42',
    conversationKey: '-100123',
    actionType: 'send_text',
    payload: { text: 'changed' },
    nowMs: 200,
  })

  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.action.payload.text, 'hello')
  assert.equal(store.markOutboundSending('answer:update:42', 300), true)
  assert.equal(store.markOutboundAmbiguous('answer:update:42', 'connection reset after upload', 400), true)
  assert.equal(store.getOutboundAction('answer:update:42').status, 'ambiguous')
  assert.equal(store.markOutboundSending('answer:update:42', 500), false)
})

test('marks sends interrupted by a process restart as ambiguous', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const actionId of ['sending', 'pending']) {
    store.createOutboundAction({
      actionId,
      conversationKey: '-100123',
      actionType: 'send_text',
      payload: { text: actionId },
      nowMs: 100,
    })
  }
  store.markOutboundSending('sending', 200)

  assert.equal(store.recoverInterruptedOutboundActions(300), 1)
  assert.equal(store.getOutboundAction('sending').status, 'ambiguous')
  assert.match(store.getOutboundAction('sending').lastError, /restart.*result unknown/iu)
  assert.equal(store.getOutboundAction('pending').status, 'pending')
  assert.equal(store.recoverInterruptedOutboundActions(400), 0)
})

test('claims due outbound actions in sequence without rerunning the source update', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const sequenceIndex of [0, 1]) {
    store.createOutboundAction({
      actionId: `answer:42:${sequenceIndex}`,
      conversationKey: '-100123',
      actionType: sequenceIndex === 0 ? 'reply' : 'send_text',
      payload: { text: `chunk-${sequenceIndex}` },
      sequenceGroup: 'answer:42',
      sequenceIndex,
      nowMs: 100,
    })
  }

  assert.equal(store.claimDueOutboundActions({ workerId: 'sender', nowMs: 100, limit: 5 }).length, 1)
  assert.equal(store.markOutboundFailed('answer:42:0', 'rate limited', 500, 110), true)
  assert.equal(store.claimDueOutboundActions({ workerId: 'sender', nowMs: 499, limit: 5 }).length, 0)
  const retried = store.claimDueOutboundActions({ workerId: 'sender', nowMs: 500, limit: 5 })
  assert.equal(retried[0].actionId, 'answer:42:0')
  assert.equal(store.markOutboundSent('answer:42:0', { telegramChatId: '-100123', telegramMessageId: '55' }, 510), true)

  const second = store.claimDueOutboundActions({ workerId: 'sender', nowMs: 511, limit: 5 })
  assert.equal(second[0].actionId, 'answer:42:1')
})

test('finds a sent bot message for reaction-to-topic routing', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.createOutboundAction({
    actionId: 'answer:42:0',
    conversationKey: '-100123:7',
    actionType: 'reply',
    payload: { text: 'answer' },
    nowMs: 100,
  })
  store.markOutboundSending('answer:42:0', 101)
  store.markOutboundSent('answer:42:0', { telegramChatId: '-100123', telegramMessageId: '55' }, 102)

  assert.equal(store.findSentOutboundMessage('-100123', '55').conversationKey, '-100123:7')
  assert.equal(store.findSentOutboundMessage('-100123', 'missing'), null)
})

test('resolves an approval once, only for the configured owner, before expiry', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  store.createApproval({
    tokenHash: 'hash-1',
    requestId: 'request-1',
    method: 'item/commandExecution/requestApproval',
    conversationKey: '-100123',
    threadId: 'thread-1',
    turnId: 'turn-1',
    ownerUserId: '9007199254740993123',
    expiresAtMs: 1_000,
    nowMs: 100,
  })

  assert.deepEqual(
    store.resolveApproval({ tokenHash: 'hash-1', ownerUserId: 'other', decision: 'approved', nowMs: 200 }),
    { resolved: false, reason: 'owner_mismatch' },
  )
  const approved = store.resolveApproval({
    tokenHash: 'hash-1',
    ownerUserId: '9007199254740993123',
    decision: 'approved',
    response: { decision: 'accept' },
    nowMs: 300,
  })
  assert.equal(approved.resolved, true)
  assert.equal(approved.approval.state, 'approved')
  assert.deepEqual(
    store.resolveApproval({ tokenHash: 'hash-1', ownerUserId: '9007199254740993123', decision: 'denied', nowMs: 400 }),
    { resolved: false, reason: 'already_resolved' },
  )
})

test('expires approvals instead of resolving them late', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.createApproval({
    tokenHash: 'hash-expired',
    requestId: 'request-2',
    method: 'item/fileChange/requestApproval',
    conversationKey: '42',
    ownerUserId: '42',
    expiresAtMs: 500,
    nowMs: 100,
  })

  assert.deepEqual(
    store.resolveApproval({ tokenHash: 'hash-expired', ownerUserId: '42', decision: 'approved', nowMs: 500 }),
    { resolved: false, reason: 'expired' },
  )
  assert.equal(store.getApproval('hash-expired').state, 'expired')
})

test('expires orphaned pending approvals during bridge startup', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  store.createApproval({
    tokenHash: 'orphaned',
    requestId: 'connection-a:1',
    method: 'item/commandExecution/requestApproval',
    conversationKey: '42',
    threadId: 'thread-1',
    turnId: 'turn-1',
    ownerUserId: '42',
    expiresAtMs: 10_000,
    nowMs: 1,
  })

  assert.equal(store.expirePendingApprovals(100), 1)
  assert.equal(store.getApproval('orphaned').state, 'expired')
  assert.equal(store.expirePendingApprovals(200), 0)
})

test('deduplicates wake requests and claims only due, unexpired rows', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const first = store.enqueueWake({
    conversationKey: '-100123:7',
    source: 'cron',
    reason: 'daily check',
    context: { schedule: 'morning' },
    dedupeKey: 'daily:2026-07-11',
    earliestAtMs: 500,
    expiresAtMs: 2_000,
    nowMs: 100,
  })
  const duplicate = store.enqueueWake({
    conversationKey: '-100123:7',
    source: 'cron',
    reason: 'duplicate',
    dedupeKey: 'daily:2026-07-11',
    earliestAtMs: 500,
    expiresAtMs: 2_000,
    nowMs: 200,
  })
  store.enqueueWake({
    conversationKey: '42',
    source: 'manual',
    reason: 'expired wake',
    dedupeKey: 'expired',
    earliestAtMs: 100,
    expiresAtMs: 400,
    nowMs: 100,
  })

  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(store.claimWakes({ workerId: 'wake-worker', nowMs: 499 }).length, 0)
  const claimed = store.claimWakes({ workerId: 'wake-worker', nowMs: 500, leaseMs: 1_000 })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].conversationKey, '-100123:7')
  assert.equal(store.getWake(duplicate.wake.id).reason, 'daily check')
  assert.equal(store.getWakeByDedupe('manual', 'expired').status, 'expired')
})

test('stores approved chat aliases and lists only durable approved surfaces', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  store.upsertApprovedChat({
    conversationKey: '-100123',
    telegramChatId: '-100123',
    alias: 'sandbox',
    title: 'Bridge Sandbox',
    kind: 'group',
    nowMs: 100,
  })
  store.upsertApprovedChat({
    conversationKey: '-100123:7',
    telegramChatId: '-100123',
    alias: 'sandbox-topic',
    title: 'Bridge Sandbox / Topic 7',
    kind: 'forum_topic',
    nowMs: 110,
  })

  assert.equal(store.getApprovedChatByAlias('sandbox').conversationKey, '-100123')
  assert.deepEqual(store.listApprovedChats().map(chat => chat.alias), ['sandbox', 'sandbox-topic'])
})

test('records Telegram messages and attachments idempotently', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const message = {
    updateId: '99',
    conversationKey: '-100123:7',
    telegramChatId: '-100123',
    telegramMessageId: '555',
    senderId: '42',
    messageType: 'message',
    metadata: { text: 'hello' },
    codexCorrelationId: 'turn-1',
    nowMs: 100,
  }
  assert.equal(store.recordMessage(message).created, true)
  assert.equal(store.recordMessage({ ...message, metadata: { text: 'changed' } }).created, false)
  assert.equal(store.listMessages('-100123:7', 10)[0].metadata.text, 'hello')

  const attachment = {
    updateId: '99',
    telegramFileId: 'file-id',
    telegramUniqueId: 'unique-id',
    localPath: '/var/lib/codex-tg-bridge/attachments/99/photo.jpg',
    mediaType: 'photo',
    byteSize: 123,
    sha256: 'a'.repeat(64),
    nowMs: 120,
  }
  assert.equal(store.recordAttachment(attachment).created, true)
  assert.equal(store.recordAttachment(attachment).created, false)
  assert.equal(store.getAttachmentByFileId('file-id').localPath, attachment.localPath)
})

test('completes or retries a wake only for its current lease owner', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  const { wake } = store.enqueueWake({
    conversationKey: '42',
    source: 'manual',
    reason: 'run now',
    dedupeKey: 'manual:1',
    earliestAtMs: 100,
    expiresAtMs: 2_000,
    nowMs: 50,
  })
  store.claimWakes({ workerId: 'wake-a', nowMs: 100, leaseMs: 500 })

  assert.equal(store.completeWake({ id: wake.id, workerId: 'wake-b', nowMs: 150 }), false)
  assert.equal(store.failWake({
    id: wake.id,
    workerId: 'wake-a',
    error: 'temporary',
    retryAtMs: 300,
    nowMs: 200,
  }), true)
  assert.equal(store.claimWakes({ workerId: 'wake-b', nowMs: 299 }).length, 0)
  assert.equal(store.claimWakes({ workerId: 'wake-b', nowMs: 300 }).length, 1)
  assert.equal(store.completeWake({ id: wake.id, workerId: 'wake-b', nowMs: 350 }), true)
  assert.equal(store.getWake(wake.id).status, 'completed')
})

test('expires a processing wake when its lease and business deadline have passed', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  const { wake } = store.enqueueWake({
    conversationKey: '42',
    source: 'sw',
    reason: 'time bounded observation',
    dedupeKey: 'sw:deadline',
    earliestAtMs: 100,
    expiresAtMs: 500,
    nowMs: 50,
  })
  store.claimWakes({ workerId: 'wake-a', nowMs: 100, leaseMs: 400 })

  assert.equal(store.claimWakes({ workerId: 'wake-b', nowMs: 500 }).length, 0)
  assert.equal(store.getWake(wake.id).status, 'expired')
})

test('relay jobs deduplicate, reclaim expired leases, and never replay accepted turns', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  const first = store.enqueueRelayJob({
    jobId: 'telegram:100',
    sourceType: 'telegram',
    sourceId: '100',
    conversationKey: '42',
    sessionLabel: 'tg-engage',
    payload: { text: 'hello' },
    expiresAtMs: 1_000,
    nowMs: 100,
  })
  const duplicate = store.enqueueRelayJob({
    jobId: 'telegram:100',
    sourceType: 'telegram',
    sourceId: '100',
    conversationKey: '42',
    sessionLabel: 'tg-engage',
    payload: { text: 'changed' },
    expiresAtMs: 1_000,
    nowMs: 110,
  })

  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.payload.text, 'hello')

  const claimed = store.claimRelayJobs({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    leaseMs: 100,
    nowMs: 200,
  })
  assert.equal(claimed[0].attempts, 1)
  assert.equal(store.claimRelayJobs({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-b',
    leaseMs: 100,
    nowMs: 299,
  }).length, 0)
  const reclaimed = store.claimRelayJobs({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-b',
    leaseMs: 100,
    nowMs: 300,
  })
  assert.equal(reclaimed[0].attempts, 2)

  assert.equal(store.acceptRelayJob({
    jobId: 'telegram:100',
    connectorId: 'connector-b',
    codexSessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    nowMs: 310,
  }), true)
  assert.equal(store.expireRelayJobs(2_000), 0)
  assert.equal(store.getRelayJob('telegram:100').status, 'accepted')
  assert.equal(store.claimRelayJobs({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-c',
    nowMs: 2_000,
  }).length, 0)
})

test('relay jobs expire silently before acceptance and complete only the accepted turn', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  store.enqueueRelayJob({
    jobId: 'telegram:expired',
    sourceType: 'telegram',
    sourceId: 'expired',
    conversationKey: '42',
    sessionLabel: 'tg-engage',
    payload: { text: 'too old' },
    expiresAtMs: 500,
    nowMs: 100,
  })
  assert.equal(store.claimRelayJobs({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    nowMs: 500,
  }).length, 0)
  assert.equal(store.getRelayJob('telegram:expired').status, 'expired')

  store.enqueueRelayJob({
    jobId: 'telegram:complete',
    sourceType: 'telegram',
    sourceId: 'complete',
    conversationKey: '42',
    sessionLabel: 'tg-engage',
    payload: { text: 'complete me' },
    expiresAtMs: 5_000,
    nowMs: 1_000,
  })
  store.claimRelayJobs({ sessionLabel: 'tg-engage', connectorId: 'connector-a', nowMs: 1_100 })
  store.acceptRelayJob({
    jobId: 'telegram:complete',
    connectorId: 'connector-a',
    codexSessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    nowMs: 1_200,
  })
  assert.equal(store.completeRelayJob({
    jobId: 'telegram:complete',
    turnId: 'other-turn',
    result: { action: 'send', text: 'wrong' },
    nowMs: 1_300,
  }), false)
  assert.equal(store.completeRelayJob({
    jobId: 'telegram:complete',
    turnId: 'turn-1',
    result: { action: 'send', text: 'done' },
    nowMs: 1_400,
  }), true)
  assert.equal(store.getRelayJob('telegram:complete').result.text, 'done')
})

test('claims, accepts, and finalizes one conversation batch atomically', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const [id, conversationKey, nowMs] of [
    ['1', 'group-a', 100],
    ['2', 'group-a', 110],
    ['3', 'group-b', 120],
  ]) {
    store.enqueueRelayJob({
      jobId: `telegram:${id}`,
      sourceType: 'telegram',
      sourceId: id,
      conversationKey,
      sessionLabel: 'tg-engage',
      payload: { text: `message ${id}` },
      expiresAtMs: 10_000,
      nowMs,
    })
  }

  const batch = store.claimRelayJobBatch({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    maxBatchBytes: 100_000,
    nowMs: 200,
  })
  assert.deepEqual(batch.map(job => job.jobId), ['telegram:1', 'telegram:2'])
  assert.equal(store.getRelayJob('telegram:3').status, 'pending')
  assert.equal(store.acceptRelayJobBatch({
    jobIds: batch.map(job => job.jobId),
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    threadId: 'thread-a',
    turnId: 'turn-a',
    nowMs: 210,
  }), true)
  assert.equal(store.acceptRelayJobBatch({
    jobIds: ['telegram:1', 'telegram:3'],
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    threadId: 'thread-a',
    turnId: 'wrong-turn',
    nowMs: 220,
  }), false)

  assert.equal(store.finalizeRelayJobBatch({
    jobIds: batch.map(job => job.jobId),
    turnId: 'turn-a',
    result: { action: 'reply', text: 'one answer' },
    outboundActions: [{
      actionId: 'batch-answer',
      conversationKey: 'group-a',
      actionType: 'reply',
      payload: { chatId: 'group-a', messageId: '2', text: 'one answer' },
    }],
    nowMs: 230,
  }), true)
  assert.equal(store.getRelayJob('telegram:1').status, 'completed')
  assert.equal(store.getRelayJob('telegram:2').status, 'completed')
  assert.equal(store.getOutboundAction('batch-answer').status, 'pending')
})

test('releases every unaccepted job in a deferred batch without crossing conversations', async t => {
  const { store } = await openStore()
  t.after(() => store.close())
  for (const id of ['1', '2']) {
    store.enqueueRelayJob({
      jobId: `telegram:${id}`,
      sourceType: 'telegram',
      sourceId: id,
      conversationKey: 'group-a',
      sessionLabel: 'tg-engage',
      payload: { text: `message ${id}` },
      expiresAtMs: 10_000,
      nowMs: 100 + Number(id),
    })
  }
  const batch = store.claimRelayJobBatch({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    maxBatchBytes: 100_000,
    nowMs: 200,
  })

  assert.equal(store.releaseRelayJobBatch({
    jobIds: batch.map(job => job.jobId),
    connectorId: 'wrong-connector',
    nowMs: 210,
  }), false)
  assert.equal(store.releaseRelayJobBatch({
    jobIds: batch.map(job => job.jobId),
    connectorId: 'connector-a',
    nowMs: 220,
  }), true)
  assert.deepEqual(batch.map(job => store.getRelayJob(job.jobId).status), ['pending', 'pending'])
})

test('relay session leases reject a second connector and scope offline notices by epoch', async t => {
  const { store } = await openStore()
  t.after(() => store.close())

  assert.deepEqual(store.ensureRelaySession('tg-engage', 100), {
    sessionLabel: 'tg-engage',
    connectorId: null,
    codexSessionId: null,
    status: 'offline',
    leaseExpiresAtMs: null,
    offlineEpoch: 1,
    connectedAtMs: null,
    disconnectedAtMs: null,
    updatedAtMs: 100,
  })
  assert.equal(store.claimOfflineNotice({
    sessionLabel: 'tg-engage',
    conversationKey: '42',
    nowMs: 110,
  }), true)
  assert.equal(store.claimOfflineNotice({
    sessionLabel: 'tg-engage',
    conversationKey: '42',
    nowMs: 120,
  }), false)

  assert.equal(store.registerRelaySession({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-1',
    leaseMs: 100,
    nowMs: 200,
  }).registered, true)
  assert.equal(store.registerRelaySession({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-b',
    codexSessionId: 'session-2',
    leaseMs: 100,
    nowMs: 250,
  }).registered, false)
  assert.equal(store.heartbeatRelaySession({
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    leaseMs: 100,
    nowMs: 250,
  }), true)
  assert.equal(store.getRelaySession('tg-engage', 349).status, 'online')
  const offline = store.getRelaySession('tg-engage', 350)
  assert.equal(offline.status, 'offline')
  assert.equal(offline.offlineEpoch, 2)
  assert.equal(store.claimOfflineNotice({
    sessionLabel: 'tg-engage',
    conversationKey: '42',
    nowMs: 360,
  }), true)
})
