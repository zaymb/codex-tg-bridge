import { EventEmitter } from 'node:events'

import {
  parseTelegramStructuredOutput,
  TELEGRAM_OUTPUT_INSTRUCTIONS,
  TELEGRAM_OUTPUT_SCHEMA,
} from './codex-runner.mjs'
import { RELAY_PROTOCOL_VERSION } from './relay-protocol.mjs'

function isActiveStatus(status) {
  return ['inProgress', 'in_progress', 'running', 'started'].includes(status)
}

function isActiveTurnError(error) {
  return /(thread|turn).{0,50}(already has|active|in progress|running)/iu.test(error?.message ?? '')
}

function finalText(turn, collectedItems) {
  const items = Array.isArray(turn?.items) && turn.items.length > 0 ? turn.items : collectedItems
  const messages = items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
  const finals = messages.filter(item => item.phase === 'final_answer')
  return (finals.length > 0 ? finals : messages).at(-1)?.text ?? ''
}

export class LocalSessionConnector extends EventEmitter {
  #app
  #relay
  #sessionLabel
  #connectorId
  #codexSessionId
  #threadId
  #heartbeatIntervalMs
  #activeTurns = new Set()
  #items = new Map()
  #currentJob = null
  #heartbeatTimer = null
  #chain = Promise.resolve()
  #started = false
  #closed = false
  #listeners = []

  constructor({
    appServerClient,
    relayClient,
    sessionLabel,
    connectorId,
    codexSessionId,
    threadId,
    heartbeatIntervalMs = 5_000,
  }) {
    super()
    this.#app = appServerClient
    this.#relay = relayClient
    this.#sessionLabel = sessionLabel
    this.#connectorId = connectorId
    this.#codexSessionId = codexSessionId
    this.#threadId = threadId
    this.#heartbeatIntervalMs = heartbeatIntervalMs
  }

  #available() {
    return this.#activeTurns.size === 0 && this.#currentJob === null
  }

  #send(frame) {
    this.#relay.send({ version: RELAY_PROTOCOL_VERSION, ...frame })
  }

  #schedule(task) {
    this.#chain = this.#chain.then(task)
    this.#chain.catch(error => this.emit('error', error))
    return this.#chain
  }

  #listen(emitter, event, listener) {
    emitter.on(event, listener)
    this.#listeners.push(() => emitter.off(event, listener))
  }

  async start() {
    if (this.#started) return
    const onTurnStarted = params => this.#schedule(() => this.#handleTurnStarted(params))
    const onItemCompleted = params => this.#schedule(() => this.#handleItemCompleted(params))
    const onTurnCompleted = params => this.#schedule(() => this.#handleTurnCompleted(params))
    const onRelayFrame = frame => this.#schedule(() => this.#handleRelayFrame(frame))
    this.#listen(this.#app, 'notification:turn/started', onTurnStarted)
    this.#listen(this.#app, 'notification:item/completed', onItemCompleted)
    this.#listen(this.#app, 'notification:turn/completed', onTurnCompleted)
    this.#listen(this.#relay, 'frame', onRelayFrame)

    const resumed = await this.#app.request('thread/resume', { threadId: this.#threadId })
    if (resumed?.thread?.id !== this.#threadId) throw new Error('Codex app-server resumed a different thread')
    for (const turn of resumed.thread.turns ?? []) {
      if (turn?.id && isActiveStatus(turn.status)) this.#activeTurns.add(turn.id)
    }
    await this.#relay.connect({
      version: RELAY_PROTOCOL_VERSION,
      type: 'hello',
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
      codexSessionId: this.#codexSessionId,
      acceptingJobs: this.#available(),
    })
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#closed) this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
    }, this.#heartbeatIntervalMs)
    this.#heartbeatTimer.unref?.()
    this.#started = true
  }

  #handleTurnStarted(params) {
    if (params.threadId !== this.#threadId || !params.turn?.id) return
    this.#activeTurns.add(params.turn.id)
    this.#send({ type: 'heartbeat', acceptingJobs: false })
  }

  #handleItemCompleted(params) {
    if (params.threadId !== this.#threadId || !params.turnId) return
    const items = this.#items.get(params.turnId) ?? []
    items.push(params.item)
    this.#items.set(params.turnId, items)
  }

  #handleTurnCompleted(params) {
    if (params.threadId !== this.#threadId || !params.turn?.id) return
    const turn = params.turn
    this.#activeTurns.delete(turn.id)
    const items = this.#items.get(turn.id) ?? []
    this.#items.delete(turn.id)

    if (this.#currentJob?.turnId === turn.id) {
      if (turn.status !== 'completed') {
        this.#send({
          type: 'job_failed',
          jobId: this.#currentJob.job.jobId,
          turnId: turn.id,
          error: turn.error?.message ?? `Codex turn ended with status ${turn.status}`,
        })
      } else {
        const output = parseTelegramStructuredOutput(finalText(turn, items))
        this.#send({
          type: 'job_result',
          jobId: this.#currentJob.job.jobId,
          turnId: turn.id,
          result: output.skipped
            ? { action: 'skip', reason: output.reason }
            : { action: 'reply', text: output.finalText, reason: output.reason },
        })
      }
      this.#currentJob.awaitingRecord = true
      return
    }
    this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
  }

  async #handleRelayFrame(frame) {
    if (!frame || frame.version !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported relay protocol version')
    if (frame.type === 'heartbeat' || frame.type === 'ready') return
    if (frame.type === 'error') throw new Error(`VPS relay error: ${frame.message}`)
    if (frame.type === 'job_recorded') {
      if (this.#currentJob?.job.jobId !== frame.jobId) return
      this.#currentJob = null
      this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
      return
    }
    if (frame.type !== 'job') throw new Error(`unsupported relay frame type: ${frame.type}`)
    if (this.#currentJob || !this.#available()) {
      this.#send({ type: 'job_deferred', jobId: frame.job.jobId, reason: 'target thread is active' })
      return
    }

    this.#currentJob = { job: frame.job, turnId: null, awaitingRecord: false }
    this.#send({ type: 'heartbeat', acceptingJobs: false })
    try {
      const response = await this.#app.request('turn/start', {
        threadId: this.#threadId,
        input: [{ type: 'text', text: frame.job.payload?.text || '[Telegram event with no text content]' }],
        clientUserMessageId: frame.job.jobId,
        additionalContext: {
          telegram: { kind: 'untrusted', value: JSON.stringify(frame.job.payload?.telegramContext ?? {}) },
          telegram_output_contract: { kind: 'application', value: TELEGRAM_OUTPUT_INSTRUCTIONS },
        },
        outputSchema: TELEGRAM_OUTPUT_SCHEMA,
      })
      const turnId = response?.turn?.id
      if (!turnId) throw new Error('Codex turn/start returned no turn ID')
      this.#currentJob.turnId = turnId
      this.#activeTurns.add(turnId)
      this.#send({
        type: 'job_accepted',
        jobId: frame.job.jobId,
        threadId: this.#threadId,
        turnId,
      })
    } catch (error) {
      if (isActiveTurnError(error)) {
        this.#send({ type: 'job_deferred', jobId: frame.job.jobId, reason: error.message })
      } else {
        this.#send({ type: 'job_failed', jobId: frame.job.jobId, error: error.message })
      }
      this.#currentJob.awaitingRecord = true
    }
  }

  idle() {
    return this.#chain
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#heartbeatTimer)
    for (const remove of this.#listeners.splice(0)) remove()
    await this.#chain.catch(() => {})
    await this.#relay.close()
  }
}
