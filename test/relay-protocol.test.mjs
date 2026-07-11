import assert from 'node:assert/strict'
import test from 'node:test'

import { RelayProtocolSession } from '../src/relay-protocol.mjs'
import { StateStore } from '../src/state-store.mjs'

function fixture() {
  const state = StateStore.open(':memory:')
  const frames = []
  let now = 1_000
  const session = new RelayProtocolSession({
    stateStore: state,
    sessionLabel: 'tg-engage',
    writeFrame: frame => frames.push(frame),
    clock: () => now,
    leaseMs: 20_000,
    jobLeaseMs: 120_000,
  })
  return { state, frames, session, setNow(value) { now = value } }
}

function enqueue(state, updateId = '1', nowMs = 1_000) {
  state.enqueueRelayJob({
    jobId: `telegram:${updateId}`,
    sourceType: 'telegram',
    sourceId: updateId,
    conversationKey: '42',
    sessionLabel: 'tg-engage',
    payload: {
      text: 'hello',
      telegramContext: {
        chatId: '42',
        conversationKey: '42',
        messageId: '10',
      },
    },
    expiresAtMs: nowMs + 86_400_000,
    nowMs,
  })
}

async function hello(setup) {
  await setup.session.handleFrame({
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs: true,
  })
}

test('registers one connector and leases only one relay job at a time', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state, '1')
  enqueue(setup.state, '2')

  await hello(setup)
  assert.equal(setup.frames[0].type, 'ready')
  assert.equal(await setup.session.claimOnce(), true)
  assert.equal(setup.frames[1].type, 'job')
  assert.equal(setup.frames[1].job.jobId, 'telegram:1')
  assert.equal(await setup.session.claimOnce(), false)

  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    jobId: 'telegram:1',
    threadId: 'thread-a',
    turnId: 'turn-a',
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'accepted')
  assert.equal(await setup.session.claimOnce(), false)
})

test('records final reply durably and acknowledges the exact accepted turn', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state)
  await hello(setup)
  await setup.session.claimOnce()
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    jobId: 'telegram:1',
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    jobId: 'telegram:1',
    turnId: 'turn-a',
    result: { action: 'reply', text: 'final answer' },
  })

  assert.equal(setup.state.getRelayJob('telegram:1').status, 'completed')
  const outbound = setup.state.getOutboundAction('relay-result:telegram:1:0000')
  assert.equal(outbound.actionType, 'reply')
  assert.equal(outbound.payload.text, 'final answer')
  assert.equal(setup.frames.at(-1).type, 'job_recorded')
  assert.equal(await setup.session.claimOnce(), false)
})

test('records SKIP without an outbound message and rejects mismatched turns', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state)
  await hello(setup)
  await setup.session.claimOnce()
  await setup.session.handleFrame({
    version: 1,
    type: 'job_accepted',
    jobId: 'telegram:1',
    threadId: 'thread-a',
    turnId: 'turn-a',
  })

  await assert.rejects(setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    jobId: 'telegram:1',
    turnId: 'wrong-turn',
    result: { action: 'skip' },
  }), /does not match/)

  await setup.session.handleFrame({
    version: 1,
    type: 'job_result',
    jobId: 'telegram:1',
    turnId: 'turn-a',
    result: { action: 'skip' },
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'completed')
  assert.equal(setup.state.claimDueOutboundActions({ workerId: 'probe', limit: 10, nowMs: 1_000 }).length, 0)
})

test('renews and releases the session lease and rejects protocol mismatches', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  await assert.rejects(setup.session.handleFrame({
    version: 2,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs: true,
  }), /protocol version/)

  await hello(setup)
  setup.setNow(5_000)
  await setup.session.handleFrame({ version: 1, type: 'heartbeat' })
  assert.equal(setup.state.getRelaySession('tg-engage', 24_999).status, 'online')
  await setup.session.close()
  assert.equal(setup.state.getRelaySession('tg-engage', 5_000).status, 'offline')
})

test('claims only while the connector is idle and can defer a start race', async t => {
  const setup = fixture()
  t.after(() => setup.state.close())
  enqueue(setup.state)
  await setup.session.handleFrame({
    version: 1,
    type: 'hello',
    sessionLabel: 'tg-engage',
    connectorId: 'connector-a',
    codexSessionId: 'session-a',
    acceptingJobs: false,
  })
  assert.equal(await setup.session.claimOnce(), false)

  await setup.session.handleFrame({ version: 1, type: 'heartbeat', acceptingJobs: true })
  assert.equal(await setup.session.claimOnce(), true)
  await setup.session.handleFrame({
    version: 1,
    type: 'job_deferred',
    jobId: 'telegram:1',
    reason: 'target thread became active',
  })
  assert.equal(setup.state.getRelayJob('telegram:1').status, 'pending')
  assert.equal(await setup.session.claimOnce(), false)
  await setup.session.handleFrame({ version: 1, type: 'heartbeat', acceptingJobs: true })
  assert.equal(await setup.session.claimOnce(), true)
})
