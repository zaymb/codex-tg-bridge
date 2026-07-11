import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBridgeRuntime } from '../src/runtime.mjs'
import { startFakeAppServer } from './fake-app-server.mjs'

const contractPath = new URL('../fixtures/codex-app-server-0.143.0/contract.json', import.meta.url)

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for integration condition')
}

test('runs Telegram to Codex to Telegram and resumes the thread after runtime restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-integration-'))
  const attachments = join(dir, 'attachments')
  const exports = join(dir, 'exports')
  await mkdir(attachments)
  await mkdir(exports)
  const appMethods = []
  let turnCounter = 0
  const fakeApp = await startFakeAppServer({
    onMessage(message, connection) {
      appMethods.push(message.method)
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'persistent-thread' } } })
      }
      if (message.method === 'thread/resume') {
        connection.send({ id: message.id, result: { thread: { id: 'persistent-thread' } } })
      }
      if (message.method === 'turn/start') {
        turnCounter += 1
        const turnId = `turn-${turnCounter}`
        connection.send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
        const item = {
          id: `item-${turnCounter}`,
          type: 'agentMessage',
          phase: 'final_answer',
          text: JSON.stringify({ action: 'send', text: `answer-${turnCounter}`, reason: 'test' }),
        }
        queueMicrotask(() => {
          connection.send({ method: 'item/agentMessage/delta', params: { threadId: 'persistent-thread', turnId, delta: 'partial' } })
          connection.send({ method: 'item/completed', params: { threadId: 'persistent-thread', turnId, completedAtMs: 1, item } })
          connection.send({
            method: 'turn/completed',
            params: { threadId: 'persistent-thread', turn: { id: turnId, status: 'completed', items: [item] } },
          })
        })
      }
    },
  })
  t.after(() => fakeApp.close())

  let updateNumber = 0
  const telegramCalls = []
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1)
    const body = options?.body instanceof FormData ? options.body : JSON.parse(options?.body ?? '{}')
    telegramCalls.push({ method, body })
    if (method === 'getMe') {
      return response({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot', first_name: 'Bridge' } })
    }
    if (method === 'getWebhookInfo') return response({ ok: true, result: { url: '' } })
    if (method === 'getUpdates') {
      updateNumber += 1
      return response({
        ok: true,
        result: [{
          update_id: updateNumber,
          message: {
            message_id: updateNumber * 10,
            date: 1,
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Owner' },
            text: `message-${updateNumber}`,
          },
        }],
      })
    }
    if (method === 'sendMessage') {
      return response({ ok: true, result: { message_id: 100 + telegramCalls.length, chat: { id: 42 } } })
    }
    if (method === 'sendChatAction') return response({ ok: true, result: true })
    throw new Error(`unexpected Telegram method ${method}`)
  }

  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    readTelegramToken: () => '123456:test-token',
    appServerSocket: fakeApp.socketPath,
    actionSocket: join(dir, 'action.sock'),
    wakeSocket: join(dir, 'wake.sock'),
    dbPath: join(dir, 'bridge.sqlite3'),
    attachmentRoot: attachments,
    exportRoots: [exports],
    codexWorkdir: dir,
    codexWritableRoots: [dir],
    model: 'gpt-test',
    effort: 'high',
    maxConcurrentTurns: 2,
    pollTimeoutSec: 1,
    turnTimeoutMs: 1_000,
    updateLeaseMs: 5_000,
    typingIntervalMs: 60_000,
  }

  const first = await createBridgeRuntime({ config, contract, fetchImpl })
  await first.start()
  await first.poller.pollOnce()
  await first.dispatcher.drainOnce()
  assert.equal(first.stateStore.getConversation('42').threadId, 'persistent-thread')
  await first.close()

  const second = await createBridgeRuntime({ config, contract, fetchImpl })
  await second.start()
  await second.poller.pollOnce()
  await second.dispatcher.drainOnce()
  await second.close()

  assert.equal(appMethods.filter(method => method === 'thread/start').length, 1)
  assert.equal(appMethods.filter(method => method === 'thread/resume').length, 1)
  assert.deepEqual(
    telegramCalls.filter(call => call.method === 'sendMessage').map(call => call.body.text),
    ['answer-1', 'answer-2'],
  )
  assert.equal(telegramCalls.some(call => JSON.stringify(call.body).includes('partial')), false)
  const polls = telegramCalls.filter(call => call.method === 'getUpdates')
  assert.equal(polls[0].body.offset, undefined)
  assert.equal(polls[1].body.offset, '2')
})

test('stops the bridge runtime when app-server disconnects while idle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-app-exit-'))
  const attachments = join(dir, 'attachments')
  const exports = join(dir, 'exports')
  await mkdir(attachments)
  await mkdir(exports)
  const fakeApp = await startFakeAppServer()
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  let releasePoll
  const pollStarted = new Promise(resolve => { releasePoll = resolve })
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1)
    if (method === 'getMe') {
      return response({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot', first_name: 'Bridge' } })
    }
    if (method === 'getWebhookInfo') return response({ ok: true, result: { url: '' } })
    if (method === 'getUpdates') {
      releasePoll()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return response({ ok: true, result: [] })
    }
    throw new Error(`unexpected Telegram method ${method}`)
  }
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    readTelegramToken: () => '123456:test-token',
    appServerSocket: fakeApp.socketPath,
    actionSocket: join(dir, 'action.sock'),
    wakeSocket: join(dir, 'wake.sock'),
    dbPath: join(dir, 'bridge.sqlite3'),
    attachmentRoot: attachments,
    exportRoots: [exports],
    codexWorkdir: dir,
    codexWritableRoots: [dir],
    model: 'gpt-test',
    effort: 'high',
    maxConcurrentTurns: 2,
    pollTimeoutSec: 50,
    turnTimeoutMs: 1_000,
    updateLeaseMs: 5_000,
    typingIntervalMs: 60_000,
  }

  const runtime = await createBridgeRuntime({ config, contract, fetchImpl })
  const running = runtime.run()
  await pollStarted
  await fakeApp.close()

  await assert.rejects(running, /app-server closed/iu)
})

test('runtime preempts an active batch when owner stop arrives in a later poll', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-runtime-stop-'))
  const attachments = join(dir, 'attachments')
  const exports = join(dir, 'exports')
  await mkdir(attachments)
  await mkdir(exports)
  let announceTurnStarted
  const turnStarted = new Promise(resolve => { announceTurnStarted = resolve })
  const interrupts = []
  const fakeApp = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/start') {
        connection.send({ id: message.id, result: { thread: { id: 'preempt-thread' } } })
      }
      if (message.method === 'turn/start') {
        connection.send({ id: message.id, result: { turn: { id: 'preempt-turn', status: 'inProgress', items: [] } } })
        connection.send({
          method: 'turn/started',
          params: {
            threadId: 'preempt-thread',
            turn: { id: 'preempt-turn', status: 'inProgress', items: [] },
          },
        })
        announceTurnStarted()
      }
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params)
        connection.send({ id: message.id, result: {} })
        queueMicrotask(() => connection.send({
          method: 'turn/completed',
          params: {
            threadId: 'preempt-thread',
            turn: { id: 'preempt-turn', status: 'interrupted', items: [] },
          },
        }))
      }
    },
  })
  t.after(() => fakeApp.close())
  let pollCount = 0
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1)
    if (method === 'getMe') {
      return response({ ok: true, result: { id: 500, is_bot: true, username: 'bridge_bot', first_name: 'Bridge' } })
    }
    if (method === 'getWebhookInfo') return response({ ok: true, result: { url: '' } })
    if (method === 'getUpdates') {
      pollCount += 1
      if (pollCount === 1) {
        return response({ ok: true, result: [{
          update_id: 1,
          message: {
            message_id: 10,
            date: 1,
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Owner' },
            text: 'start a long task',
          },
        }] })
      }
      if (pollCount === 2) {
        await turnStarted
        return response({ ok: true, result: [{
          update_id: 2,
          message: {
            message_id: 20,
            date: 2,
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Owner' },
            text: '/stop',
            entities: [{ type: 'bot_command', offset: 0, length: 5 }],
          },
        }] })
      }
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return response({ ok: true, result: [] })
    }
    if (method === 'sendMessage') {
      return response({ ok: true, result: { message_id: 100, chat: { id: 42 } } })
    }
    if (method === 'sendChatAction') return response({ ok: true, result: true })
    throw new Error(`unexpected Telegram method ${method}`)
  }
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    readTelegramToken: () => '123456:test-token',
    appServerSocket: fakeApp.socketPath,
    actionSocket: join(dir, 'action.sock'),
    wakeSocket: join(dir, 'wake.sock'),
    dbPath: join(dir, 'bridge.sqlite3'),
    attachmentRoot: attachments,
    exportRoots: [exports],
    codexWorkdir: dir,
    codexWritableRoots: [dir],
    model: 'gpt-test',
    effort: 'high',
    maxConcurrentTurns: 1,
    pollTimeoutSec: 1,
    turnTimeoutMs: 10_000,
    updateLeaseMs: 5_000,
    typingIntervalMs: 60_000,
  }
  const runtime = await createBridgeRuntime({ config, contract, fetchImpl, workerIdleMs: 5 })
  const controller = new AbortController()
  const running = runtime.run({ signal: controller.signal })

  await waitFor(() => runtime.stateStore.getUpdate('2')?.status === 'completed' && interrupts.length === 1)
  assert.deepEqual(interrupts, [{ threadId: 'preempt-thread', turnId: 'preempt-turn' }])
  assert.equal(runtime.stateStore.getUpdate('1').status, 'failed')
  controller.abort()
  await running
})
