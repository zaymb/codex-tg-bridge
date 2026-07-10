import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AppServerClient,
  AppServerProtocolError,
  AppServerRpcError,
} from '../src/app-server-client.mjs'
import { startFakeAppServer } from './fake-app-server.mjs'

const contractPath = new URL('../fixtures/codex-app-server-0.143.0/contract.json', import.meta.url)

async function loadContract() {
  return JSON.parse(await readFile(contractPath, 'utf8'))
}

test('connects over a Unix WebSocket and performs initialize then initialized', async t => {
  const fake = await startFakeAppServer()
  t.after(() => fake.close())
  const client = await AppServerClient.connect({
    socketPath: fake.socketPath,
    contract: await loadContract(),
    requestTimeoutMs: 1_000,
  })
  t.after(() => client.close())
  await fake.waitForMessage(message => message.method === 'initialized')

  assert.deepEqual(fake.messages.slice(0, 2), [
    {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'tg_engage_bridge',
          title: 'TG Engage Codex Bridge',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            'item/agentMessage/delta',
            'item/plan/delta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/textDelta',
            'item/commandExecution/outputDelta',
          ],
        },
      },
    },
    { method: 'initialized', params: {} },
  ])
  assert.equal(client.initializeResult.userAgent, 'codex-cli-test')
})

test('correlates out-of-order JSON-RPC responses', async t => {
  const pending = []
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (!['thread/start', 'thread/resume'].includes(message.method)) return
      pending.push({ message, connection })
      if (pending.length === 2) {
        pending[1].connection.send({ id: pending[1].message.id, result: { order: 2 } })
        pending[0].connection.send({ id: pending[0].message.id, result: { order: 1 } })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await loadContract() })
  t.after(() => client.close())

  const first = client.request('thread/start', { cwd: '/workspace' })
  const second = client.request('thread/resume', { threadId: 'thread-1' })
  assert.deepEqual(await second, { order: 2 })
  assert.deepEqual(await first, { order: 1 })
})

test('emits notifications but never treats delta text as a final response', async t => {
  const fake = await startFakeAppServer()
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await loadContract() })
  t.after(() => client.close())
  const received = []
  client.on('notification', notification => received.push(notification))

  fake.send({ method: 'item/agentMessage/delta', params: { delta: 'partial' } })
  fake.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'final' } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(received, [
    { method: 'item/agentMessage/delta', params: { delta: 'partial' } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'final' } } },
  ])
})

test('surfaces server requests and sends one explicit response', async t => {
  const fake = await startFakeAppServer()
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await loadContract() })
  t.after(() => client.close())

  const requestPromise = new Promise(resolve => client.once('request', resolve))
  fake.send({
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  })
  const request = await requestPromise
  assert.equal(request.id, 'approval-1')
  client.respond(request.id, { decision: 'decline' })

  assert.deepEqual(await fake.waitForMessage(message => message.id === 'approval-1'), {
    id: 'approval-1',
    result: { decision: 'decline' },
  })
  assert.throws(() => client.respond(request.id, { decision: 'accept' }), /already responded/)
})

test('turns JSON-RPC errors into typed errors', async t => {
  const fake = await startFakeAppServer({
    onMessage(message, connection) {
      if (message.method === 'thread/resume') {
        connection.send({ id: message.id, error: { code: -32602, message: 'thread missing', data: { stale: true } } })
      }
    },
  })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await loadContract() })
  t.after(() => client.close())

  await assert.rejects(client.request('thread/resume', { threadId: 'missing' }), error => {
    assert.ok(error instanceof AppServerRpcError)
    assert.equal(error.code, -32602)
    assert.deepEqual(error.data, { stale: true })
    return true
  })
})

test('fails closed on malformed frames and rejects pending requests', async t => {
  let connection
  const fake = await startFakeAppServer({ onMessage(_message, context) { connection = context } })
  t.after(() => fake.close())
  const client = await AppServerClient.connect({ socketPath: fake.socketPath, contract: await loadContract() })
  t.after(() => client.close())

  const pending = client.request('thread/start', {})
  await fake.waitForMessage(message => message.method === 'thread/start')
  connection.sendRaw('{not-json')
  await assert.rejects(pending, error => error instanceof AppServerProtocolError)
  assert.equal(client.closed, true)
})

test('rejects incompatible contracts before opening a socket', async () => {
  const contract = await loadContract()
  delete contract.schemas['item/permissions/requestApproval']

  await assert.rejects(
    AppServerClient.connect({ socketPath: '/tmp/should-not-connect.sock', contract }),
    /contract is missing item\/permissions\/requestApproval/,
  )
})
