import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { ApprovalRouter } from '../src/approval-router.mjs'
import { StateStore } from '../src/state-store.mjs'

class FakeAppServerClient extends EventEmitter {
  responses = []

  respond(id, result, error = null) {
    this.responses.push({ id, result, error })
  }
}

class FakeTelegramClient {
  messages = []
  callbacks = []

  async sendText(payload) {
    this.messages.push(payload)
    return { message_id: this.messages.length }
  }

  async answerCallbackQuery(payload) {
    this.callbacks.push(payload)
    return true
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

function callback(data, actorId = '42', chatId = '42', chatType = 'private') {
  return {
    type: 'callback_query',
    chat: { id: chatId, type: chatType },
    actor: { id: actorId, isBot: false, username: null, displayName: 'Owner' },
    callback: { id: 'callback-1', data, actor: { id: actorId }, messageId: '10', inlineMessageId: null },
  }
}

function fixture({ nowMs = 100, ttlMs = 1_000 } = {}) {
  const state = StateStore.open(':memory:')
  state.upsertConversation({ conversationKey: '-100123:7', threadId: 'thread-1', nowMs: 1 })
  state.setActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-1', nowMs: 2 })
  const client = new FakeAppServerClient()
  const telegram = new FakeTelegramClient()
  let now = nowMs
  let tokenCounter = 0
  const router = new ApprovalRouter({
    appServerClient: client,
    stateStore: state,
    telegramClient: telegram,
    ownerUserId: '42',
    approvalTtlMs: ttlMs,
    clock: () => now,
    tokenFactory: () => `opaque-token-${++tokenCounter}`,
  })
  return { state, client, telegram, router, setNow: value => { now = value } }
}

test('routes a command approval to owner DM and accepts it once', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())
  await router.handleServerRequest({
    id: 'request-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'npm test',
      cwd: '/srv/codex-workspace',
      reason: 'run verification',
    },
  })

  assert.equal(telegram.messages.length, 1)
  assert.equal(telegram.messages[0].chatId, '42')
  assert.match(telegram.messages[0].text, /npm test/)
  const approveData = telegram.messages[0].replyMarkup.inline_keyboard[0][0].callback_data
  assert.equal(approveData, 'ap:opaque-token-1:approve')

  assert.equal(await router.handleCallback(callback(approveData)), true)
  assert.deepEqual(client.responses, [{ id: 'request-1', result: { decision: 'accept' }, error: null }])
  assert.equal(state.getApproval(tokenHash('opaque-token-1')).state, 'approved')
  assert.equal(telegram.callbacks[0].text, 'Approved')
  assert.equal(await router.handleCallback(callback(approveData)), false)
  assert.equal(client.responses.length, 1)
})

test('uses decline for file changes and an empty permission profile for denied permissions', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())
  await router.handleServerRequest({
    id: 'file-request',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-file', reason: 'edit config' },
  })
  const fileDeny = telegram.messages[0].replyMarkup.inline_keyboard[0][1].callback_data
  await router.handleCallback(callback(fileDeny))

  await router.handleServerRequest({
    id: 'permission-request',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-permission',
      cwd: '/srv/codex-workspace',
      startedAtMs: 100,
      permissions: { network: { enabled: true } },
    },
  })
  const permissionDeny = telegram.messages[1].replyMarkup.inline_keyboard[0][1].callback_data
  await router.handleCallback(callback(permissionDeny))

  assert.deepEqual(client.responses, [
    { id: 'file-request', result: { decision: 'decline' }, error: null },
    { id: 'permission-request', result: { permissions: {}, scope: 'turn' }, error: null },
  ])
})

test('grants only the permission profile requested by app-server for this turn', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())
  const permissions = {
    fileSystem: { write: ['/srv/codex-workspace/exports'] },
    network: { enabled: false },
  }
  await router.handleServerRequest({
    id: 'permission-request',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-permission',
      cwd: '/srv/codex-workspace',
      startedAtMs: 100,
      permissions,
    },
  })
  const approve = telegram.messages[0].replyMarkup.inline_keyboard[0][0].callback_data
  await router.handleCallback(callback(approve))

  assert.deepEqual(client.responses[0], {
    id: 'permission-request',
    result: { permissions, scope: 'turn' },
    error: null,
  })
})

test('rejects callbacks from another user or from a group even if the owner sent them', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())
  await router.handleServerRequest({
    id: 'request-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  })
  const approve = telegram.messages[0].replyMarkup.inline_keyboard[0][0].callback_data

  assert.equal(await router.handleCallback(callback(approve, '99')), false)
  assert.equal(await router.handleCallback(callback(approve, '42', '-100123', 'supergroup')), false)
  assert.equal(client.responses.length, 0)
  assert.equal(state.getApproval(tokenHash('opaque-token-1')).state, 'pending')
  assert.ok(telegram.callbacks.every(item => item.showAlert === true))
})

test('fails closed when the active conversation turn changed before approval', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())
  await router.handleServerRequest({
    id: 'request-1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'touch x' },
  })
  const approve = telegram.messages[0].replyMarkup.inline_keyboard[0][0].callback_data
  state.clearActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-1', nowMs: 200 })
  state.setActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-2', nowMs: 201 })

  assert.equal(await router.handleCallback(callback(approve)), false)
  assert.deepEqual(client.responses, [{ id: 'request-1', result: { decision: 'decline' }, error: null }])
  assert.equal(state.getApproval(tokenHash('opaque-token-1')).state, 'denied')
})

test('expires pending approvals and releases app-server with a denial', async t => {
  const { state, client, telegram, router, setNow } = fixture({ nowMs: 100, ttlMs: 100 })
  t.after(() => state.close())
  await router.handleServerRequest({
    id: 'request-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  })
  setNow(200)

  assert.equal(await router.expirePending(), 1)
  assert.deepEqual(client.responses, [{ id: 'request-1', result: { decision: 'decline' }, error: null }])
  assert.equal(state.getApproval(tokenHash('opaque-token-1')).state, 'expired')
  assert.equal(await router.handleCallback(callback('ap:opaque-token-1:approve')), false)
  assert.equal(telegram.callbacks.at(-1).text, 'Approval is no longer active')
})

test('fails closed on unknown app-server request methods', async t => {
  const { state, client, telegram, router } = fixture()
  t.after(() => state.close())

  await router.handleServerRequest({ id: 'unknown-1', method: 'new/dangerous/request', params: {} })

  assert.deepEqual(client.responses, [{
    id: 'unknown-1',
    result: null,
    error: { code: -32601, message: 'Unsupported app-server request: new/dangerous/request' },
  }])
  assert.equal(telegram.messages.length, 0)
})
