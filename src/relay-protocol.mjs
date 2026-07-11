import { splitTelegramText } from './message-format.mjs'

export const RELAY_PROTOCOL_VERSION = 1

function requireText(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}

function outboundActions(job, result, nowMs) {
  if (result.action === 'skip') return []
  if (result.action !== 'reply' || typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('job result must be a non-empty reply or skip')
  }
  const context = job.payload?.telegramContext
  if (!context?.chatId || !context?.conversationKey) throw new Error('relay job is missing Telegram reply context')
  const chunks = splitTelegramText(result.text)
  const group = `relay-result:${job.jobId}`
  return chunks.map((text, index) => {
    const first = index === 0 && context.messageId
    return {
      actionId: `${group}:${String(index).padStart(4, '0')}`,
      conversationKey: context.conversationKey,
      actionType: first ? 'reply' : 'send_text',
      payload: {
        chatId: context.chatId,
        messageId: first ? context.messageId : null,
        threadId: context.threadId ?? null,
        text,
      },
      sequenceGroup: group,
      sequenceIndex: index,
      nowMs,
    }
  })
}

export class RelayProtocolSession {
  #state
  #sessionLabel
  #writeFrame
  #clock
  #leaseMs
  #jobLeaseMs
  #connectorId = null
  #codexSessionId = null
  #inflightJobId = null
  #acceptingJobs = false
  #closed = false

  constructor({
    stateStore,
    sessionLabel,
    writeFrame,
    clock = Date.now,
    leaseMs = 20_000,
    jobLeaseMs = 120_000,
  }) {
    this.#state = stateStore
    this.#sessionLabel = sessionLabel
    this.#writeFrame = writeFrame
    this.#clock = clock
    this.#leaseMs = leaseMs
    this.#jobLeaseMs = jobLeaseMs
  }

  get ready() {
    return this.#connectorId !== null && !this.#closed
  }

  #write(frame) {
    this.#writeFrame({ version: RELAY_PROTOCOL_VERSION, ...frame })
  }

  async handleFrame(frame) {
    if (this.#closed) throw new Error('relay session is closed')
    if (!frame || frame.version !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported relay protocol version')
    if (!this.ready) return this.#handleHello(frame)
    if (frame.type === 'heartbeat') {
      if (!this.#state.heartbeatRelaySession({
        sessionLabel: this.#sessionLabel,
        connectorId: this.#connectorId,
        leaseMs: this.#leaseMs,
        nowMs: this.#clock(),
      })) throw new Error('relay session lease was lost')
      if (typeof frame.acceptingJobs === 'boolean') this.#acceptingJobs = frame.acceptingJobs
      this.#write({ type: 'heartbeat', nowMs: this.#clock() })
      return
    }
    if (frame.type === 'job_accepted') return this.#handleAccepted(frame)
    if (frame.type === 'job_deferred') return this.#handleDeferred(frame)
    if (frame.type === 'job_result') return this.#handleResult(frame)
    if (frame.type === 'job_failed') return this.#handleFailed(frame)
    throw new Error(`unsupported relay frame type: ${frame.type}`)
  }

  #handleHello(frame) {
    if (frame.type !== 'hello') throw new Error('hello must be the first relay frame')
    const sessionLabel = requireText(frame.sessionLabel, 'sessionLabel')
    if (sessionLabel !== this.#sessionLabel) throw new Error('relay session label does not match')
    const connectorId = requireText(frame.connectorId, 'connectorId')
    const codexSessionId = requireText(frame.codexSessionId, 'codexSessionId')
    const registered = this.#state.registerRelaySession({
      sessionLabel,
      connectorId,
      codexSessionId,
      leaseMs: this.#leaseMs,
      nowMs: this.#clock(),
    })
    if (!registered.registered) throw new Error(`relay session unavailable: ${registered.reason}`)
    this.#connectorId = connectorId
    this.#codexSessionId = codexSessionId
    this.#acceptingJobs = frame.acceptingJobs === true
    this.#write({ type: 'ready', sessionLabel, leaseMs: this.#leaseMs })
  }

  async claimOnce() {
    if (!this.ready || !this.#acceptingJobs || this.#inflightJobId) return false
    const [job] = this.#state.claimRelayJobs({
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
      limit: 1,
      leaseMs: this.#jobLeaseMs,
      nowMs: this.#clock(),
    })
    if (!job) return false
    this.#inflightJobId = job.jobId
    this.#acceptingJobs = false
    this.#write({ type: 'job', job })
    return true
  }

  #requireInflight(frame) {
    const jobId = requireText(frame.jobId, 'jobId')
    if (jobId !== this.#inflightJobId) throw new Error('relay frame does not match the inflight job')
    const job = this.#state.getRelayJob(jobId)
    if (!job) throw new Error('relay job no longer exists')
    return job
  }

  #handleAccepted(frame) {
    this.#requireInflight(frame)
    const threadId = requireText(frame.threadId, 'threadId')
    const turnId = requireText(frame.turnId, 'turnId')
    if (!this.#state.acceptRelayJob({
      jobId: frame.jobId,
      connectorId: this.#connectorId,
      codexSessionId: this.#codexSessionId,
      threadId,
      turnId,
      nowMs: this.#clock(),
    })) throw new Error('relay job could not be accepted')
  }

  #handleDeferred(frame) {
    this.#requireInflight(frame)
    requireText(frame.reason, 'reason')
    if (!this.#state.releaseRelayJob({
      jobId: frame.jobId,
      connectorId: this.#connectorId,
      nowMs: this.#clock(),
    })) throw new Error('relay job could not be deferred')
    this.#inflightJobId = null
    this.#write({ type: 'job_recorded', jobId: frame.jobId })
  }

  #handleResult(frame) {
    const job = this.#requireInflight(frame)
    const turnId = requireText(frame.turnId, 'turnId')
    if (job.status !== 'accepted' || job.turnId !== turnId) {
      throw new Error('relay result does not match the accepted turn')
    }
    const actions = outboundActions(job, frame.result ?? {}, this.#clock())
    if (!this.#state.finalizeRelayJob({
      jobId: job.jobId,
      turnId,
      result: frame.result,
      outboundActions: actions,
      nowMs: this.#clock(),
    })) throw new Error('relay result could not be recorded')
    this.#inflightJobId = null
    this.#write({ type: 'job_recorded', jobId: job.jobId })
  }

  #handleFailed(frame) {
    const job = this.#requireInflight(frame)
    const error = requireText(frame.error, 'error')
    const failed = this.#state.failRelayJob({
      jobId: job.jobId,
      error,
      connectorId: job.status === 'leased' ? this.#connectorId : null,
      turnId: job.status === 'accepted' ? frame.turnId : null,
      nowMs: this.#clock(),
    })
    if (!failed) throw new Error('relay failure does not match the active job')
    this.#inflightJobId = null
    this.#write({ type: 'job_recorded', jobId: job.jobId })
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#connectorId) {
      this.#state.disconnectRelaySession({
        sessionLabel: this.#sessionLabel,
        connectorId: this.#connectorId,
        nowMs: this.#clock(),
      })
    }
  }
}
