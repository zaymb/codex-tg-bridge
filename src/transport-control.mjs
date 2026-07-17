const STATE_KEY = 'transport_control_state'
const ERROR_KEY = 'transport_control_error'

const AWAY_MIN_MINUTES = 1
const AWAY_MAX_MINUTES = 60

export const AWAY_ACK_PREFIX = 'transport-control:away:'
export const AWAY_INVALID_PREFIX = 'transport-control:away-invalid:'
export const DISENGAGE_ACK_PREFIX = 'transport-control:disengage:'

export const AWAY_INVALID_REPLY = 'Invalid request. Use /away 1m–60m.'
export const DISENGAGE_REPLY = 'Until next time.'

export class DisengagedError extends Error {
  constructor(message = 'transport disengaged by admin command') {
    super(message)
    this.name = 'DisengagedError'
  }
}

function isAdmin(update, ownerUserId) {
  return update.actor?.id === String(ownerUserId) && update.actor?.isBot !== true
}

// Strips a leading-command bot mention in both accepted spellings:
// `/away@bot 15m` and `/away @bot 15m`. A mention of a different bot means
// the command is not addressed to us — callers must not execute it.
function normalizeCommandText(text, botUsername) {
  const trimmed = text.trim()
  const match = trimmed.match(/^(\/[a-z]+)(@[A-Za-z0-9_]+)?(?:\s+(@[A-Za-z0-9_]+))?([\s\S]*)$/iu)
  if (!match) return { text: trimmed, foreignMention: false }
  const [, command, inlineMention, spacedMention, rest] = match
  const mention = inlineMention ?? spacedMention
  if (!mention) return { text: trimmed, foreignMention: false }
  if (botUsername && mention.toLowerCase() === `@${botUsername.toLowerCase()}`) {
    return { text: `${command}${rest}`.trim().replace(/\s+/gu, ' '), foreignMention: false }
  }
  return { text: trimmed, foreignMention: true }
}

// Transport-level command parser. Admin-only (owner's real sender ID, never a
// bot); trust classification is irrelevant here by design — slash commands are
// a transport special case. Returns null when the text is not a transport
// command addressed to this bot.
export function parseTransportCommand(update, { ownerUserId, botUsername = null } = {}) {
  if (update.type !== 'message') return null
  if (!isAdmin(update, ownerUserId)) return null
  const raw = update.message?.text
  if (typeof raw !== 'string' || !raw.trimStart().startsWith('/')) return null
  const { text, foreignMention } = normalizeCommandText(raw, botUsername)
  if (foreignMention) return null

  if (/^\/away\b/iu.test(text)) {
    const match = text.match(/^\/away\s+(\d+)m$/iu)
    if (match) {
      const minutes = Number(match[1])
      if (Number.isSafeInteger(minutes) && minutes >= AWAY_MIN_MINUTES && minutes <= AWAY_MAX_MINUTES) {
        return { kind: 'away', minutes, durationMs: minutes * 60_000 }
      }
    }
    return { kind: 'away_invalid' }
  }
  if (/^\/disengage$/iu.test(text)) return { kind: 'disengage' }
  return null
}

// Early-release trigger: the admin's real sender ID explicitly @-mentioning
// this bot. Anyone else's mention never matches.
export function isAwayReleaseMention(update, { ownerUserId, botUsername }) {
  if (update.type !== 'message') return false
  if (!isAdmin(update, ownerUserId)) return false
  if (!botUsername) return false
  const text = update.message?.text ?? update.message?.caption ?? ''
  return new RegExp(`(?:^|[^A-Za-z0-9_])@${botUsername}(?:$|[^A-Za-z0-9_])`, 'iu').test(text)
}

// Persistent transport control state, stored as one JSON settings row so every
// transition is a single atomic write and survives plain process restarts.
//
// away:      { phase: 'pending'|'active', requestedDurationMs, untilMs?,
//              ackActionId, previous?: { untilMs } }
// disengage: { phase: 'pending'|'active', ackActionId }
//
// Race rule (v2.1): pending is set in the same tick the command is claimed, so
// new turns are blocked while the ack is still in flight. The away timer only
// starts at ack delivery: untilMs = ackSentAt + requestedDurationMs.
export class TransportControl {
  #state
  #clock

  constructor({ stateStore, clock = Date.now }) {
    this.#state = stateStore
    this.#clock = clock
  }

  read() {
    const raw = this.#state.getSetting(STATE_KEY)
    if (!raw) return { away: null, disengage: null }
    try {
      const parsed = JSON.parse(raw)
      return { away: parsed.away ?? null, disengage: parsed.disengage ?? null }
    } catch {
      return { away: null, disengage: null }
    }
  }

  #write(value, nowMs = this.#clock()) {
    this.#state.setSetting(STATE_KEY, JSON.stringify(value), nowMs)
  }

  #writeError(kind, detail, nowMs = this.#clock()) {
    this.#state.setSetting(ERROR_KEY, JSON.stringify({ atMs: nowMs, kind, detail }), nowMs)
  }

  lastError() {
    const raw = this.#state.getSetting(ERROR_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  // --- command entry points -------------------------------------------------

  // Returns { accepted, ackActionId } — accepted=false when a disengage is in
  // progress (disengage outranks away; the command is dropped silently).
  requestAway({ durationMs, ackActionId, nowMs = this.#clock() }) {
    const state = this.read()
    if (state.disengage) return { accepted: false }
    const previous = state.away?.phase === 'active' && state.away.untilMs > nowMs
      ? { untilMs: state.away.untilMs }
      : state.away?.previous ?? null
    this.#write({
      ...state,
      away: {
        phase: 'pending',
        requestedDurationMs: durationMs,
        ackActionId,
        ...(previous ? { previous } : {}),
      },
    }, nowMs)
    return { accepted: true }
  }

  // Returns { accepted } — duplicate requests while one is pending/active are
  // dropped (no second farewell).
  requestDisengage({ ackActionId, nowMs = this.#clock() }) {
    const state = this.read()
    if (state.disengage) return { accepted: false }
    this.#write({ ...state, disengage: { phase: 'pending', ackActionId } }, nowMs)
    return { accepted: true }
  }

  // Admin @bot mention: clears away entirely (pending or active). A still
  // in-flight ack may deliver afterwards; its promotion becomes a no-op.
  releaseAway(nowMs = this.#clock()) {
    const state = this.read()
    if (!state.away) return false
    this.#write({ ...state, away: null }, nowMs)
    return true
  }

  clearExpiredAway(nowMs = this.#clock()) {
    const state = this.read()
    if (state.away?.phase !== 'active') return false
    if (state.away.untilMs > nowMs) return false
    this.#write({ ...state, away: null }, nowMs)
    return true
  }

  // --- ack delivery hooks (wired into the outbound drain) --------------------

  // Called when any outbound action reaches 'sent'. The away timer starts here:
  // full requested duration measured from confirmed delivery.
  handleAckSent(actionId, sentAtMs = this.#clock()) {
    const state = this.read()
    if (state.away?.phase === 'pending' && state.away.ackActionId === actionId) {
      this.#write({
        ...state,
        away: {
          phase: 'active',
          requestedDurationMs: state.away.requestedDurationMs,
          untilMs: sentAtMs + state.away.requestedDurationMs,
          ackActionId: actionId,
        },
      }, sentAtMs)
      return 'away'
    }
    if (state.disengage?.phase === 'pending' && state.disengage.ackActionId === actionId) {
      this.#write({ ...state, disengage: { phase: 'active', ackActionId: actionId } }, sentAtMs)
      return 'disengage'
    }
    return null
  }

  // Called when an ack reaches a terminal non-delivery ('failed' with no retry,
  // or 'ambiguous'). Hard boundary (v2.1): disengage must never activate
  // without a confirmed farewell — revert and surface the error. Away reverts
  // to its snapshotted previous timer when one exists.
  handleAckTerminal(actionId, status, nowMs = this.#clock()) {
    const state = this.read()
    if (state.away?.phase === 'pending' && state.away.ackActionId === actionId) {
      const previous = state.away.previous
      this.#write({
        ...state,
        away: previous
          ? {
            phase: 'active',
            requestedDurationMs: state.away.requestedDurationMs,
            untilMs: previous.untilMs,
            ackActionId: actionId,
          }
          : null,
      }, nowMs)
      this.#writeError('away_ack_undelivered', { actionId, status }, nowMs)
      return 'away'
    }
    if (state.disengage?.phase === 'pending' && state.disengage.ackActionId === actionId) {
      this.#write({ ...state, disengage: null }, nowMs)
      this.#writeError('disengage_ack_undelivered', { actionId, status }, nowMs)
      return 'disengage'
    }
    return null
  }

  // --- gates ------------------------------------------------------------------

  isAway(nowMs = this.#clock()) {
    const state = this.read()
    if (!state.away) return false
    if (state.away.phase === 'pending') return true
    return state.away.untilMs > nowMs
  }

  isDisengagePending() {
    return this.read().disengage?.phase === 'pending'
  }

  isDisengaged() {
    return this.read().disengage?.phase === 'active'
  }

  // --- restart recovery -------------------------------------------------------

  // Re-derives pending phases from the ack action's terminal state after a
  // process restart. Rules (v2.1): sent -> promote (away timer from the
  // action's sent timestamp when available), terminal failure -> revert,
  // still queued/retrying -> stay pending and let the drain hooks finish it.
  recover({ getOutboundAction, nowMs = this.#clock() }) {
    const state = this.read()
    for (const key of ['away', 'disengage']) {
      const entry = state[key]
      if (entry?.phase !== 'pending') continue
      const action = getOutboundAction(entry.ackActionId)
      if (!action) {
        this.handleAckTerminal(entry.ackActionId, 'missing', nowMs)
        continue
      }
      if (action.status === 'sent') {
        this.handleAckSent(entry.ackActionId, action.updatedAtMs ?? nowMs)
      } else if (action.status === 'ambiguous' || (action.status === 'failed' && action.nextAttemptAtMs === null)) {
        this.handleAckTerminal(entry.ackActionId, action.status, nowMs)
      }
    }
    return this.read()
  }
}
