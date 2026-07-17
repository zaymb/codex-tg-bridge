import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { AppServerClient } from '../src/app-server-client.mjs'
import {
  CodexRunner,
  CodexTurnFailedError,
  CodexTurnTimeoutError,
  parseTelegramStructuredOutput,
  TELEGRAM_BATCH_OUTPUT_SCHEMA,
} from '../src/codex-runner.mjs'
import { StateStore } from '../src/state-store.mjs'
import { startFakeAppServer } from './fake-app-server.mjs'

const contractPath = new URL('../fixtures/codex-app-server-0.143.0/contract.json', import.meta.url)

async function contract() {
  return JSON.parse(await readFile(contractPath, 'utf8'))
}

function config(overrides = {}) {
  return {
    codexWorkdir: '/srv/codex-workspace',
    codexWritableRoots: ['/srv/codex-workspace'],
    model: 'gpt-test',
    effort: 'high',
    turnTimeoutMs: 1_000,
    ...overrides,
  }
}

function sendCompletedTurn(connection, { threadId, turnId, output, status = 'completed', error = null }) {
  const item = { id: `item-${turnId}`, type: 'agentMessage', phase: 'final_answer', text: output }
  queueMicrotask(() => {
    connection.send({
      method: 'item/completed',
      params: { threadId, turnId, completedAtMs: 10, item },
    })
    connection.send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status, error, items: [item] } },
    })
  })
}

test('parses optional targeted Telegram responses without losing legacy text output', () => {
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send',
    text: '',
    responses: [
      { messageId: '10', text: 'answer the first' },
      { messageId: '20', text: 'answer the second' },
    ],
    reason: 'selective batch reply',
  })), {
    skipped: false,
    finalText: '',
    responses: [
      { messageId: '10', action: 'reply', text: 'answer the first' },
      { messageId: '20', action: 'reply', text: 'answer the second' },
    ],
    action: 'send',
    reason: 'selective batch reply',
  })
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send', text: 'legacy reply', reason: 'compatibility',
  })).responses, [])
  assert.equal(TELEGRAM_BATCH_OUTPUT_SCHEMA.properties.responses.maxItems, 32)
  assert.deepEqual(TELEGRAM_BATCH_OUTPUT_SCHEMA.properties.responses.items.properties.action.enum, [
    'send', 'react', 'dice',
  ])
  assert.deepEqual(TELEGRAM_BATCH_OUTPUT_SCHEMA.required, ['action', 'text', 'responses', 'reason'])
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'react', text: '🗿', responses: [], reason: 'acknowledge',
  })), {
    action: 'react',
    skipped: false,
    finalText: '🗿',
    responses: [],
    reason: 'acknowledge',
  })
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send',
    text: '',
    responses: [{ messageId: '30', action: 'dice', text: '🎲' }],
    reason: 'let Telegram roll',
  })).responses, [{ messageId: '30', action: 'dice', text: '🎲' }])
})

test('normalizes targeted response aliases and never combines them with root text', () => {
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send',
    text: '',
    responses: [{ message_id: 6957, text: 'targeted answer' }],
    reason: 'model used the inbound field spelling',
  })), {
    action: 'send',
    skipped: false,
    finalText: '',
    responses: [{ messageId: '6957', action: 'reply', text: 'targeted answer' }],
    reason: 'model used the inbound field spelling',
  })

  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send',
    text: 'one final answer',
    responses: [{ message_id: 6957, text: 'one final answer' }],
    reason: 'model duplicated the reply into both fields',
  })), {
    action: 'send',
    skipped: false,
    finalText: 'one final answer',
    responses: [],
    reason: 'model duplicated the reply into both fields',
  })
})

test('fails closed when an empty root reply contains malformed targeted responses', () => {
  assert.deepEqual(parseTelegramStructuredOutput(JSON.stringify({
    action: 'send',
    text: '',
    responses: [{ text: 'missing target' }],
    reason: 'invalid target',
  })), {
    action: 'skip',
    skipped: true,
    finalText: null,
    responses: [],
    reason: 'malformed_structured_output',
  })
})

test('fails closed instead of leaking a structured envelope with trailing garbage', () => {
  assert.deepEqual(parseTelegramStructuredOutput(
    '{"action":"skip","text":"","responses":[],"reason":"no reply"} trailing words',
  ), {
    action: 'skip',
    skipped: true,
    finalText: null,
    responses: [],
    reason: 'no reply',
  })
  assert.deepEqual(parseTelegramStructuredOutput('{"action":"send","text":'), {
    action: 'skip',
    skipped: true,
    finalText: null,
    responses: [],
    reason: 'malformed_structured_output',
  })
})

test('starts and persists an owner-DM thread, then returns only structured final output', async t => {
  let turnParams
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-owner' } } })
      }
      if (message.method === 'turn/start') {
        turnParams = message.params
        connection.send({ id: message.id, result: { turn: { id: 'turn-owner', status: 'inProgress', items: [] } } })
        connection.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-owner', turnId: 'turn-owner', delta: 'partial must not escape' } })
        sendCompletedTurn(connection, {
          threadId: 'thread-owner',
          turnId: 'turn-owner',
          output: JSON.stringify({ action: 'send', text: 'Final answer', reason: 'direct reply' }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  const result = await runner.runTurn({
    conversationKey: '42',
    ownerDm: true,
    text: 'Please inspect the project',
    telegramContext: { chatId: '42', senderId: '42', messageId: '10' },
    clientUserMessageId: 'tg:10',
  })

  assert.equal(result.threadId, 'thread-owner')
  assert.equal(result.turnId, 'turn-owner')
  assert.equal(result.finalText, 'Final answer')
  assert.equal(result.skipped, false)
  assert.equal(result.contextBreak, false)
  assert.equal(store.getConversation('42').threadId, 'thread-owner')
  assert.equal(store.getConversation('42').activeTurnId, null)
  assert.deepEqual(turnParams.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: ['/srv/codex-workspace'],
    networkAccess: false,
  })
  assert.equal(turnParams.approvalPolicy, 'on-request')
  assert.equal(turnParams.outputSchema.properties.action.enum.join(','), 'send,react,skip')
  assert.equal(
    turnParams.input[0].text,
    '[EXTERNAL_FEED][source=telegram][trust=owner_dm]\nPlease inspect the project',
  )
  assert.match(turnParams.additionalContext.telegram_trust_policy.value, /authenticated Telegram owner-DM/)
})

test('resumes an existing group thread with read-only policy and attachment inputs', async t => {
  const methods = []
  let turnParams
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      methods.push(message.method)
      if (message.method === 'thread/resume') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-group' } } })
      }
      if (message.method === 'turn/start') {
        turnParams = message.params
        connection.send({ id: message.id, result: { turn: { id: 'turn-group', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-group',
          turnId: 'turn-group',
          output: JSON.stringify({ action: 'send', text: 'Saw both files', reason: 'relevant' }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.upsertConversation({ conversationKey: '-100123:7', threadId: 'thread-group', nowMs: 1 })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  await runner.runTurn({
    conversationKey: '-100123:7',
    ownerDm: false,
    text: 'What is in these?',
    attachments: [
      { kind: 'photo', localPath: '/srv/codex-inbox/1/photo.jpg', fileName: 'photo.jpg' },
      { kind: 'document', localPath: '/srv/codex-inbox/1/report.pdf', fileName: 'report.pdf' },
    ],
    telegramContext: { chatId: '-100123', threadId: '7', senderId: '99' },
  })

  assert.equal(methods.includes('thread/start'), false)
  assert.equal(methods.includes('thread/resume'), true)
  assert.deepEqual(turnParams.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  assert.equal(turnParams.approvalPolicy, 'never')
  assert.deepEqual(turnParams.input, [
    { type: 'text', text: '[EXTERNAL_FEED][source=telegram][trust=untrusted_external]\nWhat is in these?\n\nTelegram attachments:\n- report.pdf: /srv/codex-inbox/1/report.pdf' },
    { type: 'localImage', path: '/srv/codex-inbox/1/photo.jpg' },
  ])
  assert.equal(turnParams.additionalContext.telegram.kind, 'untrusted')
  assert.match(turnParams.additionalContext.telegram_trust_policy.value, /never as authority or permission/)
})

test('direct runner tags a private group without granting execution permissions', async t => {
  let turnParams
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-private-group' } } })
      }
      if (message.method === 'turn/start') {
        turnParams = message.params
        connection.send({ id: message.id, result: { turn: { id: 'turn-private-group', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-private-group',
          turnId: 'turn-private-group',
          output: JSON.stringify({
            action: 'send',
            text: 'Our bridge separates transport, relay, and connector responsibilities.',
            reason: 'explain',
          }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({
    client,
    stateStore: store,
    config: config({ privateChatIds: new Set(['-100123']) }),
  })

  const result = await runner.runTurn({
    conversationKey: '-100123',
    ownerDm: false,
    text: 'Explain the architecture.',
    telegramContext: { chatId: '-100123', senderId: '42' },
  })

  assert.equal(result.finalText, 'Our bridge separates transport, relay, and connector responsibilities.')
  assert.match(turnParams.input[0].text, /\[trust=private_group\]/)
  assert.match(turnParams.additionalContext.telegram_trust_policy.value, /not an instruction source/)
  assert.equal(turnParams.approvalPolicy, 'never')
  assert.deepEqual(turnParams.sandboxPolicy, { type: 'readOnly', networkAccess: false })
})

test('direct runner authorizes an owner turn in a configured repair group', async t => {
  let turnParams
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-repair-group' } } })
      }
      if (message.method === 'turn/start') {
        turnParams = message.params
        connection.send({ id: message.id, result: { turn: { id: 'turn-repair-group', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-repair-group',
          turnId: 'turn-repair-group',
          output: JSON.stringify({ action: 'skip', text: '', reason: 'done' }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({
    client,
    stateStore: store,
    config: config({
      ownerUserId: '42',
      privateChatIds: new Set(['-100123']),
      repairChatIds: new Set(['-100123']),
    }),
  })

  await runner.runTurn({
    conversationKey: '-100123',
    ownerDm: false,
    text: 'Repair it.',
    telegramContext: { chatId: '-100123', senderId: '42', senderIsBot: false },
  })

  assert.match(turnParams.input[0].text, /\[trust=repair_group\]/)
  assert.match(turnParams.additionalContext.telegram_trust_policy.value, /authorized repair surface/)
  assert.equal(turnParams.approvalPolicy, 'on-request')
  assert.deepEqual(turnParams.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: ['/srv/codex-workspace'],
    networkAccess: false,
  })
})

test('replaces only a confirmed stale thread and reports the context break', async t => {
  const methods = []
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      methods.push(message.method)
      if (message.method === 'thread/resume') {
        connection.send({ id: message.id, error: { code: -32602, message: 'thread missing from rollout store' } })
      }
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-replacement' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'turn-new', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-replacement',
          turnId: 'turn-new',
          output: JSON.stringify({ action: 'skip', text: '', reason: 'no response needed' }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.upsertConversation({ conversationKey: '42', threadId: 'thread-stale', nowMs: 1 })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  const result = await runner.runTurn({ conversationKey: '42', ownerDm: true, text: 'hello' })

  assert.deepEqual(methods.filter(method => method.startsWith('thread/')), ['thread/resume', 'thread/start'])
  assert.equal(result.contextBreak, true)
  assert.equal(result.replacedThreadId, 'thread-stale')
  assert.equal(result.skipped, true)
  assert.equal(result.finalText, null)
  assert.equal(store.getConversation('42').threadId, 'thread-replacement')
})

test('does not replace a thread for non-stale resume errors', async t => {
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/resume') {
        connection.send({ id: message.id, error: { code: -32000, message: 'authentication expired' } })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.upsertConversation({ conversationKey: '42', threadId: 'thread-keep', nowMs: 1 })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  await assert.rejects(runner.runTurn({ conversationKey: '42', ownerDm: true, text: 'hello' }), /authentication expired/)
  assert.equal(store.getConversation('42').threadId, 'thread-keep')
})

test('keeps an explicit turn/start RPC rejection retryable', async t => {
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-rejected' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, error: { code: -32602, message: 'invalid turn parameters' } })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  await assert.rejects(
    runner.runTurn({
      conversationKey: '42',
      ownerDm: true,
      text: 'hello',
      clientUserMessageId: 'telegram:55',
    }),
    error => /invalid turn parameters/.test(error.message) && error.turnAccepted !== true,
  )
  assert.equal(store.getConversation('42').activeTurnId, null)
})

test('interrupts the exact timed-out turn and clears active state', async t => {
  let interrupted
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-timeout' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'turn-timeout', status: 'inProgress', items: [] } } })
      }
      if (message.method === 'turn/interrupt') {
        interrupted = message.params
        connection.send({ id: message.id, result: {} })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config({ turnTimeoutMs: 30 }) })

  await assert.rejects(
    runner.runTurn({ conversationKey: '-100123:7', ownerDm: false, text: 'wait' }),
    error => error instanceof CodexTurnTimeoutError,
  )
  assert.deepEqual(interrupted, { threadId: 'thread-timeout', turnId: 'turn-timeout' })
  assert.equal(store.getConversation('-100123:7').activeTurnId, null)
})

test('reports failed turns and clears active state', async t => {
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-fail' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'turn-fail', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-fail',
          turnId: 'turn-fail',
          output: '',
          status: 'failed',
          error: { message: 'model unavailable' },
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  await assert.rejects(
    runner.runTurn({ conversationKey: '42', ownerDm: true, text: 'hello' }),
    error => error instanceof CodexTurnFailedError && /model unavailable/.test(error.message),
  )
  assert.equal(store.getConversation('42').activeTurnId, null)
})

test('rejects immediately and clears active state when app-server disconnects mid-turn', async t => {
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-disconnect' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'turn-disconnect', status: 'inProgress', items: [] } } })
        queueMicrotask(() => connection.close())
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config({ turnTimeoutMs: 10_000 }) })

  await assert.rejects(
    runner.runTurn({ conversationKey: '42', ownerDm: true, text: 'hello' }),
    error => /app-server closed/iu.test(error.message) && error.turnAccepted === true,
  )
  assert.equal(store.getConversation('42').activeTurnId, null)
})

test('interrupts and clears active turns left by a hard bridge restart', async t => {
  const interrupted = []
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'turn/interrupt') {
        interrupted.push(message.params)
        connection.send({ id: message.id, result: {} })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.storeUpdate({ updateId: '88', raw: { update_id: 88 }, normalizedType: 'message', nowMs: 1 })
  store.claimUpdates({ workerId: 'old-worker', nowMs: 2 })
  store.upsertConversation({ conversationKey: '-100123:7', threadId: 'thread-old', nowMs: 1 })
  store.beginActiveTurn({
    conversationKey: '-100123:7',
    placeholderTurnId: 'turn-old',
    sourceId: 'telegram:88',
    nowMs: 2,
  })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  assert.equal(await runner.recoverInterruptedTurns(), 1)
  assert.deepEqual(interrupted, [{ threadId: 'thread-old', turnId: 'turn-old' }])
  assert.equal(store.getConversation('-100123:7').activeTurnId, null)
  assert.equal(store.getUpdate('88').status, 'failed')
  assert.match(store.getUpdate('88').lastError, /restart.*outcome unknown/iu)
  assert.equal(await runner.recoverInterruptedTurns(), 0)
})

test('persists a starting marker before sending turn/start', async t => {
  let marker
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-marker' } } })
      }
      if (message.method === 'turn/start') {
        marker = store.listActiveConversations()[0]
        connection.send({ id: message.id, result: { turn: { id: 'turn-marker', status: 'inProgress', items: [] } } })
        sendCompletedTurn(connection, {
          threadId: 'thread-marker',
          turnId: 'turn-marker',
          output: JSON.stringify({ action: 'skip', text: '', reason: 'test' }),
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  await runner.runTurn({
    conversationKey: '42',
    ownerDm: true,
    text: 'hello',
    clientUserMessageId: 'telegram:99',
  })

  assert.equal(marker.activeTurnId, 'starting:telegram:99')
  assert.equal(marker.activeSourceId, 'telegram:99')
})

test('does not replay a source left in the pre-response turn/start window', async t => {
  const interrupts = []
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params)
        connection.send({ id: message.id, result: {} })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.storeUpdate({ updateId: '100', raw: { update_id: 100 }, normalizedType: 'message', nowMs: 1 })
  store.claimUpdates({ workerId: 'old-worker', nowMs: 2 })
  store.upsertConversation({ conversationKey: '42', threadId: 'thread-starting', nowMs: 1 })
  store.beginActiveTurn({
    conversationKey: '42',
    placeholderTurnId: 'starting:telegram:100',
    sourceId: 'telegram:100',
    nowMs: 2,
  })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  assert.equal(await runner.recoverInterruptedTurns(), 1)
  assert.deepEqual(interrupts, [])
  assert.equal(store.getUpdate('100').status, 'failed')
  assert.match(store.getUpdate('100').lastError, /automatic replay disabled/)
})

test('queues stop during turn/start and interrupts only after the real turn is started', async t => {
  let releaseStart
  const allowStartResponse = new Promise(resolve => { releaseStart = resolve })
  const interrupts = []
  const fake = await startFakeAppServer({
    async onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'thread-race' } } })
      }
      if (message.method === 'turn/start') {
        await allowStartResponse
        connection.send({ id: message.id, result: { turn: { id: 'turn-race', status: 'inProgress', items: [] } } })
        connection.send({
          method: 'turn/started',
          params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'inProgress', items: [] } },
        })
      }
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params)
        connection.send({ id: message.id, result: {} })
        connection.send({
          method: 'turn/completed',
          params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'interrupted', items: [] } },
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })
  const running = runner.runTurn({
    conversationKey: '42',
    ownerDm: true,
    text: 'long task',
    clientUserMessageId: 'telegram:101',
  })
  await fake.waitForMessage(message => message.method === 'turn/start')

  assert.equal(store.getConversation('42').activeTurnId, 'starting:telegram:101')
  assert.equal(await runner.interrupt('42'), true)
  assert.deepEqual(interrupts, [])
  releaseStart()
  await assert.rejects(running, /interrupted/)

  assert.deepEqual(interrupts, [{ threadId: 'thread-race', turnId: 'turn-race' }])
  assert.equal(store.getConversation('42').activeTurnId, null)
})

test('queues stop while thread creation is still pending', async t => {
  let releaseThread
  const allowThreadResponse = new Promise(resolve => { releaseThread = resolve })
  const interrupts = []
  const fake = await startFakeAppServer({
    async onMessage(message, connection) {
      if (message.method === 'thread/start') {
        await allowThreadResponse
        connection.send({ id: message.id, result: { thread: { id: 'thread-before-marker' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'turn-before-marker', status: 'inProgress', items: [] } } })
        connection.send({
          method: 'turn/started',
          params: {
            threadId: 'thread-before-marker',
            turn: { id: 'turn-before-marker', status: 'inProgress', items: [] },
          },
        })
      }
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params)
        connection.send({ id: message.id, result: {} })
        connection.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-before-marker',
            turn: { id: 'turn-before-marker', status: 'interrupted', items: [] },
          },
        })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  const runner = new CodexRunner({ client, stateStore: store, config: config() })
  const running = runner.runTurn({
    conversationKey: '42',
    ownerDm: true,
    text: 'long task',
    clientUserMessageId: 'telegram:102',
  })
  await fake.waitForMessage(message => message.method === 'thread/start')

  assert.equal(store.getConversation('42'), null)
  assert.equal(await runner.interrupt('42'), true)
  releaseThread()
  await assert.rejects(running, /interrupted/)

  assert.deepEqual(interrupts, [{ threadId: 'thread-before-marker', turnId: 'turn-before-marker' }])
})

test('manual interrupt targets only the requested conversation key', async t => {
  const interrupts = []
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params)
        connection.send({ id: message.id, result: {} })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await contract() })
  t.after(() => client.close())
  const store = StateStore.open(':memory:')
  t.after(() => store.close())
  store.upsertConversation({ conversationKey: '-100123:7', threadId: 'thread-7', nowMs: 1 })
  store.setActiveTurn({ conversationKey: '-100123:7', turnId: 'turn-7', nowMs: 2 })
  store.upsertConversation({ conversationKey: '-100123:8', threadId: 'thread-8', nowMs: 1 })
  store.setActiveTurn({ conversationKey: '-100123:8', turnId: 'turn-8', nowMs: 2 })
  const runner = new CodexRunner({ client, stateStore: store, config: config() })

  assert.equal(await runner.interrupt('-100123:7'), true)
  assert.deepEqual(interrupts, [{ threadId: 'thread-7', turnId: 'turn-7' }])
  assert.equal(store.getConversation('-100123:8').activeTurnId, 'turn-8')
})
