import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AWAY_INVALID_REPLY,
  DISENGAGE_REPLY,
  TransportControl,
  isAwayReleaseMention,
  parseTransportCommand,
} from '../src/transport-control.mjs'

const CONTEXT = { ownerUserId: '42', botUsername: 'bridge_bot' }

function update(text, { senderId = '42', isBot = false, type = 'message' } = {}) {
  return {
    type,
    conversationKey: '42',
    chat: { id: '42', type: 'private' },
    actor: senderId === null ? null : { id: senderId, isBot },
    message: type === 'message' ? { id: '900', text } : null,
  }
}

function fakeStore() {
  const settings = new Map()
  return {
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, String(value)),
  }
}

// --- parseTransportCommand --------------------------------------------------

test('accepts /away with integer minutes across the 1m-60m range', () => {
  for (const [text, minutes] of [['/away 1m', 1], ['/away 60m', 60], ['/away 15m', 15], ['/AWAY  15m', 15]]) {
    const parsed = parseTransportCommand(update(text), CONTEXT)
    assert.deepEqual(parsed, { kind: 'away', minutes, durationMs: minutes * 60_000 }, text)
  }
})

test('accepts both bot mention spellings and rejects a foreign bot mention', () => {
  assert.equal(parseTransportCommand(update('/away@bridge_bot 15m'), CONTEXT).kind, 'away')
  assert.equal(parseTransportCommand(update('/away @bridge_bot 15m'), CONTEXT).kind, 'away')
  assert.equal(parseTransportCommand(update('/disengage@Bridge_Bot'), CONTEXT).kind, 'disengage')
  assert.equal(parseTransportCommand(update('/disengage @bridge_bot'), CONTEXT).kind, 'disengage')
  assert.equal(parseTransportCommand(update('/away@other_bot 15m'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('/disengage @other_bot'), CONTEXT), null)
})

test('malformed /away variants are invalid, not commands for the model', () => {
  for (const text of ['/away', '/away 0m', '/away 61m', '/away 900m', '/away abc', '/away 1.5m', '/away 15', '/away 15m extra']) {
    assert.deepEqual(parseTransportCommand(update(text), CONTEXT), { kind: 'away_invalid' }, text)
  }
})

test('/disengage is exact-form only', () => {
  assert.deepEqual(parseTransportCommand(update('/disengage'), CONTEXT), { kind: 'disengage' })
  assert.equal(parseTransportCommand(update('/disengage now'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('/disengagex'), CONTEXT), null)
})

test('accepts exact admin stop controls without treating prose as a command', () => {
  assert.deepEqual(parseTransportCommand(update('/stop'), CONTEXT), { kind: 'interrupt' })
  assert.deepEqual(parseTransportCommand(update('/stop@bridge_bot'), CONTEXT), { kind: 'interrupt' })
  assert.deepEqual(parseTransportCommand(update('停'), CONTEXT), { kind: 'interrupt' })
  assert.deepEqual(parseTransportCommand(update('stop'), CONTEXT), { kind: 'interrupt' })
  assert.deepEqual(parseTransportCommand(update(' STOP '), CONTEXT), { kind: 'interrupt' })
  assert.deepEqual(parseTransportCommand(update('/continue'), CONTEXT), { kind: 'resume' })
  assert.deepEqual(parseTransportCommand(update('/continue@bridge_bot'), CONTEXT), { kind: 'resume' })
  assert.deepEqual(parseTransportCommand(update('继续'), CONTEXT), { kind: 'resume' })
  assert.deepEqual(parseTransportCommand(update('continue'), CONTEXT), { kind: 'resume' })
  assert.equal(parseTransportCommand(update('停一下'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('stop now'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('/stop now'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('continue working'), CONTEXT), null)
})

test('accepts exact per-agent stop controls and rejects unknown targets', () => {
  for (const text of ['/stop elio', '/stop@bridge_bot elio', '/stop @bridge_bot elio', 'stop elio', ' STOP ELIO ']) {
    assert.deepEqual(parseTransportCommand(update(text), CONTEXT), { kind: 'interrupt', target: 'elio' }, text)
  }
  for (const text of ['/stop laurie', '/stop@bridge_bot laurie', 'stop laurie']) {
    assert.deepEqual(parseTransportCommand(update(text), CONTEXT), { kind: 'interrupt', target: 'laurie' }, text)
  }
  assert.equal(parseTransportCommand(update('/stop gale'), CONTEXT), null)
  assert.equal(parseTransportCommand(update('stop gale'), CONTEXT), null)
})

test('only the admin sender qualifies; bots with the admin id never do', () => {
  assert.equal(parseTransportCommand(update('/away 15m', { senderId: '77' }), CONTEXT), null)
  assert.equal(parseTransportCommand(update('/away 15m', { senderId: '42', isBot: true }), CONTEXT), null)
  assert.equal(parseTransportCommand(update('/away 15m', { senderId: null }), CONTEXT), null)
  assert.equal(parseTransportCommand(update('hello'), CONTEXT), null)
})

// --- isAwayReleaseMention ---------------------------------------------------

test('release mention requires the admin real sender and this bot', () => {
  assert.equal(isAwayReleaseMention(update('回来吧 @bridge_bot'), CONTEXT), true)
  assert.equal(isAwayReleaseMention(update('@BRIDGE_BOT wake'), CONTEXT), true)
  assert.equal(isAwayReleaseMention(update('@bridge_bot2 hi'), CONTEXT), false)
  assert.equal(isAwayReleaseMention(update('@other_bot hi'), CONTEXT), false)
  assert.equal(isAwayReleaseMention(update('@bridge_bot hi', { senderId: '77' }), CONTEXT), false)
  assert.equal(isAwayReleaseMention(update('@bridge_bot hi', { senderId: '42', isBot: true }), CONTEXT), false)
  assert.equal(isAwayReleaseMention(update('no mention here'), CONTEXT), false)
})

// --- state machine ----------------------------------------------------------

test('away pending blocks immediately; the timer starts at ack delivery', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  assert.equal(control.isAway(1_000), false)
  assert.deepEqual(control.requestAway({ durationMs: 900_000, ackActionId: 'ack-1', nowMs: 1_000 }), { accepted: true })
  assert.equal(control.isAway(1_000), true, 'pending must already gate new turns')

  assert.equal(control.handleAckSent('ack-1', 5_000), 'away')
  const state = control.read()
  assert.equal(state.away.phase, 'active')
  assert.equal(state.away.untilMs, 5_000 + 900_000, 'full duration measured from confirmed delivery')
  assert.equal(control.isAway(5_000 + 900_000 - 1), true)
  assert.equal(control.clearExpiredAway(5_000 + 900_000), true)
  assert.equal(control.isAway(5_000 + 900_000), false)
})

test('away ack failure without prior away reverts to normal and records the error', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestAway({ durationMs: 60_000, ackActionId: 'ack-1', nowMs: 1_000 })
  assert.equal(control.handleAckTerminal('ack-1', 'failed', 2_000), 'away')
  assert.equal(control.isAway(2_000), false)
  assert.equal(control.lastError().kind, 'away_ack_undelivered')
})

test('re-away snapshots the old timer and restores it when the new ack fails', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestAway({ durationMs: 600_000, ackActionId: 'ack-1', nowMs: 1_000 })
  control.handleAckSent('ack-1', 2_000)
  const originalUntil = control.read().away.untilMs

  control.requestAway({ durationMs: 1_800_000, ackActionId: 'ack-2', nowMs: 10_000 })
  assert.equal(control.read().away.phase, 'pending')
  assert.equal(control.read().away.previous.untilMs, originalUntil)

  assert.equal(control.handleAckTerminal('ack-2', 'ambiguous', 11_000), 'away')
  const state = control.read()
  assert.equal(state.away.phase, 'active', 'must fall back to the old timer, not to normal')
  assert.equal(state.away.untilMs, originalUntil)
})

test('re-away success overwrites the timer from the new ack delivery', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestAway({ durationMs: 600_000, ackActionId: 'ack-1', nowMs: 1_000 })
  control.handleAckSent('ack-1', 2_000)
  control.requestAway({ durationMs: 1_800_000, ackActionId: 'ack-2', nowMs: 10_000 })
  control.handleAckSent('ack-2', 12_000)
  assert.equal(control.read().away.untilMs, 12_000 + 1_800_000)
})

test('admin release clears pending away and a late ack promotion is a no-op', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestAway({ durationMs: 600_000, ackActionId: 'ack-1', nowMs: 1_000 })
  assert.equal(control.releaseAway(2_000), true)
  assert.equal(control.isAway(2_000), false)
  assert.equal(control.handleAckSent('ack-1', 3_000), null)
  assert.equal(control.isAway(3_000), false)
})

test('disengage hard boundary: only a confirmed farewell activates it', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  assert.deepEqual(control.requestDisengage({ ackActionId: 'bye-1', nowMs: 1_000 }), { accepted: true })
  assert.equal(control.isDisengagePending(), true)
  assert.equal(control.isDisengaged(), false)

  assert.equal(control.handleAckTerminal('bye-1', 'ambiguous', 2_000), 'disengage')
  assert.equal(control.isDisengagePending(), false, 'ambiguous must revert, never silently disconnect')
  assert.equal(control.isDisengaged(), false)
  assert.equal(control.lastError().kind, 'disengage_ack_undelivered')

  control.requestDisengage({ ackActionId: 'bye-2', nowMs: 3_000 })
  assert.equal(control.handleAckSent('bye-2', 4_000), 'disengage')
  assert.equal(control.isDisengaged(), true)
  assert.equal(control.isDisengageReady(), false, 'activation alone must not disconnect the local relay')
  assert.equal(control.markDisengageReady(5_000), true)
  assert.equal(control.isDisengageReady(), true)
  assert.equal(control.read().disengage.readyAtMs, 5_000)
  assert.equal(control.markDisengageReady(6_000), false, 'the ready transition is idempotent')
})

test('duplicate disengage and away-during-disengage are dropped', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestDisengage({ ackActionId: 'bye-1', nowMs: 1_000 })
  assert.deepEqual(control.requestDisengage({ ackActionId: 'bye-2', nowMs: 2_000 }), { accepted: false })
  assert.deepEqual(control.requestAway({ durationMs: 60_000, ackActionId: 'ack-9', nowMs: 2_000 }), { accepted: false })
})

test('interrupt requests are durable, idempotent, and explicitly acknowledged', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  assert.deepEqual(control.requestInterrupt({
    requestId: 'interrupt-1',
    conversationKey: '-100123:7',
    nowMs: 1_000,
  }), { accepted: true })
  assert.deepEqual(control.requestInterrupt({
    requestId: 'interrupt-1',
    conversationKey: '-100123:7',
    nowMs: 2_000,
  }), { accepted: false })

  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'interrupt-1',
    conversationKey: '-100123:7',
    requestedAtMs: 1_000,
  })
  assert.equal(control.completeInterrupt('other', 3_000), false)
  assert.equal(control.completeInterrupt('interrupt-1', 3_000), true)
  assert.equal(control.nextInterrupt(), null)
})

test('continue requests preserve their control action through the durable queue', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  assert.deepEqual(control.requestInterrupt({
    requestId: 'resume-1',
    conversationKey: '-100123:7',
    action: 'continue',
    nowMs: 1_000,
  }), { accepted: true })

  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'resume-1',
    conversationKey: '-100123:7',
    action: 'continue',
    requestedAtMs: 1_000,
  })
  assert.throws(() => control.requestInterrupt({
    requestId: 'bad-1',
    conversationKey: '-100123:7',
    action: 'pause',
  }), /stop or continue/u)
})

test('targeted stop requests preserve their target through the durable queue', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  assert.deepEqual(control.requestInterrupt({
    requestId: 'interrupt-elio-1',
    conversationKey: '-100123:7',
    target: 'elio',
    nowMs: 1_000,
  }), { accepted: true })

  assert.deepEqual(control.nextInterrupt(), {
    requestId: 'interrupt-elio-1',
    conversationKey: '-100123:7',
    target: 'elio',
    requestedAtMs: 1_000,
  })
  assert.throws(() => control.requestInterrupt({
    requestId: 'interrupt-unknown-1',
    conversationKey: '-100123:7',
    target: 'gale',
  }), /all, elio, or laurie/u)
})

test('recover promotes, reverts, or keeps pending based on the ack terminal state', () => {
  const cases = [
    { action: { status: 'sent', updatedAtMs: 7_000, nextAttemptAtMs: null }, awayAfter: 'active' },
    { action: { status: 'failed', nextAttemptAtMs: null }, awayAfter: null },
    { action: { status: 'ambiguous', nextAttemptAtMs: null }, awayAfter: null },
    { action: { status: 'failed', nextAttemptAtMs: 9_000 }, awayAfter: 'pending' },
    { action: { status: 'pending', nextAttemptAtMs: 9_000 }, awayAfter: 'pending' },
    { action: null, awayAfter: null },
  ]
  for (const { action, awayAfter } of cases) {
    const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
    control.requestAway({ durationMs: 600_000, ackActionId: 'ack-1', nowMs: 1_000 })
    const state = control.recover({ getOutboundAction: () => action, nowMs: 6_000 })
    assert.equal(state.away?.phase ?? null, awayAfter, JSON.stringify(action))
    if (awayAfter === 'active') {
      assert.equal(state.away.untilMs, 7_000 + 600_000, 'recovered timer starts at the recorded delivery time')
    }
  }
})

test('recover activates a disengage whose farewell was sent before the restart', () => {
  const control = new TransportControl({ stateStore: fakeStore(), clock: () => 1_000 })
  control.requestDisengage({ ackActionId: 'bye-1', nowMs: 1_000 })
  control.recover({
    getOutboundAction: () => ({ status: 'sent', updatedAtMs: 2_000, nextAttemptAtMs: null }),
    nowMs: 6_000,
  })
  assert.equal(control.isDisengaged(), true)
})

test('exports the canonical reply texts', () => {
  assert.equal(AWAY_INVALID_REPLY, 'Invalid request. Use /away 1m–60m.')
  assert.equal(DISENGAGE_REPLY, 'Until next time.')
})
