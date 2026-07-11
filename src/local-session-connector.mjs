import { EventEmitter } from 'node:events'

import {
  parseTelegramStructuredOutput,
  TELEGRAM_BATCH_OUTPUT_INSTRUCTIONS,
  TELEGRAM_BATCH_OUTPUT_SCHEMA,
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

function normalizeInbound(frame) {
  if (frame.type === 'job_batch') {
    const batch = frame.batch
    if (!batch?.batchId || !Array.isArray(batch.jobs) || batch.jobs.length === 0) {
      throw new Error('relay job_batch is malformed')
    }
    return { mode: 'batch', batchId: batch.batchId, jobs: batch.jobs }
  }
  if (frame.type === 'job' && frame.job?.jobId) {
    return { mode: 'legacy', batchId: frame.job.jobId, jobs: [frame.job] }
  }
  return null
}

function senderLabel(context) {
  return context.senderDisplayName || context.senderUsername || context.senderId || 'unknown sender'
}

function conversationLabel(context) {
  return context.conversationKey || context.chatId || 'unknown'
}

function messageLine(job) {
  const context = job.payload?.telegramContext ?? {}
  const sender = senderLabel(context)
  const conversation = conversationLabel(context)
  const replyTarget = context.replyTo?.senderDisplayName
    || context.replyTo?.senderUsername
    || context.replyTo?.senderId
  const replyNote = replyTarget ? ` (replying to ${replyTarget})` : ''
  const messageId = context.messageId ?? 'unknown'
  return `[TG][conversation_key=${conversation}][message_id=${messageId}][sender=${sender}]${replyNote}\n${job.payload?.text || '[no text]'}`
}

function batchInput(jobs) {
  if (jobs.length === 1) {
    return [{ type: 'text', text: messageLine(jobs[0]) }]
  }
  const lines = [
    `[TG BATCH: ${jobs.length} messages received while the previous turn was busy]`,
    'Read them in order. You may answer once in text, or use responses to reply selectively to any listed message_id values.',
  ]
  jobs.forEach((job, index) => {
    const context = job.payload?.telegramContext ?? {}
    const sender = senderLabel(context)
    const conversation = conversationLabel(context)
    const replyTarget = context.replyTo?.senderDisplayName
      || context.replyTo?.senderUsername
      || context.replyTo?.senderId
    const replyNote = replyTarget ? ` (replying to ${replyTarget})` : ''
    const messageId = context.messageId ?? 'unknown'
    lines.push(`${index + 1}. [TG][conversation_key=${conversation}][message_id=${messageId}] ${sender}${replyNote}: ${job.payload?.text || '[no text]'}`)
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

export class LocalSessionConnector extends EventEmitter {
  #app
  #relay
  #sessionLabel
  #connectorId
  #codexSessionId
  #threadId
  #heartbeatIntervalMs
  #approvalPolicy
  #sandboxPolicy
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
    approvalPolicy = null,
    sandboxPolicy = null,
  }) {
    super()
    this.#app = appServerClient
    this.#relay = relayClient
    this.#sessionLabel = sessionLabel
    this.#connectorId = connectorId
    this.#codexSessionId = codexSessionId
    this.#threadId = threadId
    this.#heartbeatIntervalMs = heartbeatIntervalMs
    this.#approvalPolicy = approvalPolicy
    this.#sandboxPolicy = sandboxPolicy
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

  #replaceActiveTurns(thread) {
    this.#activeTurns = new Set((thread?.turns ?? [])
      .filter(turn => turn?.id && isActiveStatus(turn.status))
      .map(turn => turn.id))
  }

  async #reconcileAvailability() {
    if (this.#currentJob) return
    const resumed = await this.#app.request('thread/resume', { threadId: this.#threadId })
    if (resumed?.thread?.id !== this.#threadId) throw new Error('Codex app-server resumed a different thread')
    this.#replaceActiveTurns(resumed.thread)
    this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
  }

  async start() {
    if (this.#started) return
    const onTurnStarted = params => this.#schedule(() => this.#handleTurnStarted(params))
    const onItemStarted = params => this.#schedule(() => this.#handleItemStarted(params))
    const onItemCompleted = params => this.#schedule(() => this.#handleItemCompleted(params))
    const onTurnCompleted = params => this.#schedule(() => this.#handleTurnCompleted(params))
    const onRelayFrame = frame => this.#schedule(() => this.#handleRelayFrame(frame))
    this.#listen(this.#app, 'notification:turn/started', onTurnStarted)
    this.#listen(this.#app, 'notification:item/started', onItemStarted)
    this.#listen(this.#app, 'notification:item/completed', onItemCompleted)
    this.#listen(this.#app, 'notification:turn/completed', onTurnCompleted)
    this.#listen(this.#relay, 'frame', onRelayFrame)

    const resumed = await this.#app.request('thread/resume', { threadId: this.#threadId })
    if (resumed?.thread?.id !== this.#threadId) throw new Error('Codex app-server resumed a different thread')
    this.#replaceActiveTurns(resumed.thread)
    await this.#relay.connect({
      version: RELAY_PROTOCOL_VERSION,
      type: 'hello',
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
      codexSessionId: this.#codexSessionId,
      acceptingJobs: this.#available(),
    })
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed) return
      this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
      if (!this.#currentJob) this.#schedule(() => this.#reconcileAvailability())
    }, this.#heartbeatIntervalMs)
    this.#heartbeatTimer.unref?.()
    this.#started = true
  }

  #handleTurnStarted(params) {
    if (params.threadId !== this.#threadId || !params.turn?.id) return
    this.#activeTurns.add(params.turn.id)
    this.#send({ type: 'heartbeat', acceptingJobs: false })
  }

  #trackUserInput(params) {
    if (
      params.threadId !== this.#threadId
      || params.turnId !== this.#currentJob?.turnId
      || params.item?.type !== 'userMessage'
    ) return

    if (params.item.clientId !== this.#currentJob.clientUserMessageId && !this.#currentJob.mixedSource) {
      this.emit('channelCollision', {
        turnId: params.turnId,
        expectedClientId: this.#currentJob.clientUserMessageId,
        receivedClientId: params.item.clientId ?? null,
      })
      this.#currentJob.mixedSource = true
    }
  }

  #handleItemStarted(params) {
    this.#trackUserInput(params)
  }

  #handleItemCompleted(params) {
    if (params.threadId !== this.#threadId || !params.turnId) return
    this.#trackUserInput(params)
    const items = this.#items.get(params.turnId) ?? []
    items.push(params.item)
    this.#items.set(params.turnId, items)
  }

  #resultFrame(type, fields = {}) {
    if (this.#currentJob.mode === 'legacy') {
      return { type, jobId: this.#currentJob.jobs[0].jobId, ...fields }
    }
    return { type, batchId: this.#currentJob.batchId, ...fields }
  }

  #handleTurnCompleted(params) {
    if (params.threadId !== this.#threadId || !params.turn?.id) return
    const turn = params.turn
    this.#activeTurns.delete(turn.id)
    const items = this.#items.get(turn.id) ?? []
    this.#items.delete(turn.id)

    if (this.#currentJob?.turnId === turn.id) {
      if (turn.status !== 'completed') {
        this.#send(this.#resultFrame('job_failed', {
          turnId: turn.id,
          error: turn.error?.message ?? `Codex turn ended with status ${turn.status}`,
        }))
      } else if (this.#currentJob.mixedSource) {
        // A local steer joined this Telegram-owned turn. The final answer is now
        // mixed-channel content, so fail closed instead of leaking it to Telegram.
        this.#send(this.#resultFrame('job_result', {
          turnId: turn.id,
          result: { action: 'skip', reason: 'mixed_source_turn' },
        }))
      } else {
        const output = parseTelegramStructuredOutput(finalText(turn, items))
        this.#send(this.#resultFrame('job_result', {
          turnId: turn.id,
          result: output.skipped
            ? { action: 'skip', reason: output.reason }
            : {
                action: 'reply',
                text: output.finalText,
                responses: output.responses,
                reason: output.reason,
              },
        }))
      }
      this.#currentJob.awaitingRecord = true
      return
    }
    this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
  }

  #recordedMatches(frame) {
    if (!this.#currentJob) return false
    return this.#currentJob.mode === 'legacy'
      ? frame.jobId === this.#currentJob.jobs[0].jobId
      : frame.batchId === this.#currentJob.batchId
  }

  async #handleRelayFrame(frame) {
    if (!frame || frame.version !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported relay protocol version')
    if (frame.type === 'heartbeat' || frame.type === 'ready') {
      this.emit('relayStatus', {
        status: 'connected',
        remoteNowMs: frame.nowMs ?? null,
      })
      return
    }
    if (frame.type === 'error') throw new Error(`VPS relay error: ${frame.message}`)
    if (frame.type === 'job_recorded') {
      if (!this.#recordedMatches(frame)) return
      this.#currentJob = null
      this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
      return
    }

    const inbound = normalizeInbound(frame)
    if (!inbound) throw new Error(`unsupported relay frame type: ${frame.type}`)
    if (this.#currentJob || !this.#available()) {
      const deferred = inbound.mode === 'legacy'
        ? { type: 'job_deferred', jobId: inbound.jobs[0].jobId, reason: 'target thread is active' }
        : { type: 'job_deferred', batchId: inbound.batchId, reason: 'target thread is active' }
      this.#send(deferred)
      return
    }

    const clientUserMessageId = inbound.mode === 'legacy' ? inbound.jobs[0].jobId : inbound.batchId
    this.#currentJob = {
      ...inbound,
      turnId: null,
      awaitingRecord: false,
      clientUserMessageId,
      mixedSource: false,
    }
    this.#send({ type: 'heartbeat', acceptingJobs: false })
    try {
      const telegramMessages = inbound.jobs.map(job => job.payload?.telegramContext ?? {})
      const response = await this.#app.request('turn/start', {
        threadId: this.#threadId,
        input: batchInput(inbound.jobs),
        clientUserMessageId,
        additionalContext: {
          telegram: {
            kind: 'untrusted',
            value: JSON.stringify({
              source: 'telegram',
              transportStatus: 'connected',
              batchId: inbound.batchId,
              messageCount: inbound.jobs.length,
              messages: telegramMessages,
            }),
          },
          telegram_source: {
            kind: 'application',
            value: '[TG] This turn originated from Telegram. Turns without this marker originate from the terminal or another local client.',
          },
          telegram_output_contract: { kind: 'application', value: TELEGRAM_BATCH_OUTPUT_INSTRUCTIONS },
        },
        outputSchema: TELEGRAM_BATCH_OUTPUT_SCHEMA,
        ...(this.#approvalPolicy ? { approvalPolicy: this.#approvalPolicy } : {}),
        ...(this.#sandboxPolicy ? { sandboxPolicy: this.#sandboxPolicy } : {}),
      })
      const turnId = response?.turn?.id
      if (!turnId) throw new Error('Codex turn/start returned no turn ID')
      this.#currentJob.turnId = turnId
      this.#activeTurns.add(turnId)
      this.#send(this.#resultFrame('job_accepted', {
        threadId: this.#threadId,
        turnId,
      }))
    } catch (error) {
      const type = isActiveTurnError(error) ? 'job_deferred' : 'job_failed'
      const field = type === 'job_deferred' ? { reason: error.message } : { error: error.message }
      this.#send(this.#resultFrame(type, field))
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
