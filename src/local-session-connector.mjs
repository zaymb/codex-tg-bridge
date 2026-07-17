import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  approvalDetail,
  approvalResponse,
  SUPPORTED_APPROVAL_METHODS,
} from './approval-router.mjs'
import {
  parseTelegramStructuredOutput,
  TELEGRAM_BATCH_OUTPUT_INSTRUCTIONS,
} from './codex-runner.mjs'
import {
  TELEGRAM_TRUST,
  TELEGRAM_TRUST_POLICIES,
  classifyTelegramJobs,
  externalFeedTag,
  guardTelegramOutput,
  isInstructionTrust,
} from './channel-trust.mjs'
import { RELAY_ATTACHMENT_CAPABILITY, RELAY_PROTOCOL_VERSION } from './relay-protocol.mjs'
import { RelayAttachmentReceiver } from './relay-attachment-transfer.mjs'

function isActiveStatus(status) {
  return ['inProgress', 'in_progress', 'running', 'started'].includes(status)
}

function isActiveTurnError(error) {
  return /(thread|turn).{0,50}(already has|active|in progress|running)/iu.test(error?.message ?? '')
}

function sandboxMode(policy) {
  if (policy?.type === 'dangerFullAccess') return 'danger-full-access'
  if (policy?.type === 'readOnly') return 'read-only'
  if (policy?.type === 'workspaceWrite') return 'workspace-write'
  return null
}

function finalText(turn, collectedItems) {
  const items = Array.isArray(turn?.items) && turn.items.length > 0 ? turn.items : collectedItems
  const messages = items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
  const finals = messages.filter(item => item.phase === 'final_answer')
  return finals.at(-1)?.text ?? null
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

function topicLabel(context) {
  return context.threadName ? `[topic=${context.threadName}]` : ''
}

function messageBody(job) {
  const attachments = job.payload?.attachments ?? []
  const files = attachments
    .filter(attachment => attachment.codexInput !== 'localImage')
    .map(attachment => `- ${attachment.fileName || attachment.kind}: ${attachment.localPath}`)
  const suffix = files.length > 0 ? `\n\nTelegram attachments:\n${files.join('\n')}` : ''
  const imagePrompt = attachments.some(attachment => attachment.codexInput === 'localImage')
    ? '请查看附图并回应。'
    : '[no text]'
  return `${job.payload?.text || imagePrompt}${suffix}`
}

function messageLine(job, trust) {
  const context = job.payload?.telegramContext ?? {}
  const sender = senderLabel(context)
  const conversation = conversationLabel(context)
  const replyTarget = context.replyTo?.senderDisplayName
    || context.replyTo?.senderUsername
    || context.replyTo?.senderId
  const replyNote = replyTarget ? ` (replying to ${replyTarget})` : ''
  const messageId = context.messageId ?? 'unknown'
  return `${externalFeedTag(trust)}\n[TG][conversation_key=${conversation}]${topicLabel(context)}[message_id=${messageId}][sender=${sender}]${replyNote}\n${messageBody(job)}`
}

function localImages(jobs) {
  return jobs.flatMap(job => (job.payload?.attachments ?? [])
    .filter(attachment => attachment.codexInput === 'localImage')
    .map(attachment => ({ type: 'localImage', path: attachment.localPath })))
}

function batchInput(jobs, trust) {
  if (jobs.length === 1) {
    return [{ type: 'text', text: messageLine(jobs[0], trust) }, ...localImages(jobs)]
  }
  const lines = [
    externalFeedTag(trust),
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
    lines.push(`${index + 1}. [TG][conversation_key=${conversation}]${topicLabel(context)}[message_id=${messageId}] ${sender}${replyNote}: ${messageBody(job)}`)
  })
  return [{ type: 'text', text: lines.join('\n') }, ...localImages(jobs)]
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
  #ownerUserId
  #privateChatIds
  #repairChatIds
  #approvalTtlMs
  #clock
  #activeTurns = new Set()
  #items = new Map()
  #currentJob = null
  #heartbeatTimer = null
  #chain = Promise.resolve()
  #started = false
  #closed = false
  #listeners = []
  #pendingApprovals = new Map()
  #attachmentReceiver = null
  #attachmentStore = null

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
    ownerUserId,
    privateChatIds = new Set(),
    repairChatIds = new Set(),
    approvalTtlMs = 10 * 60 * 1_000,
    clock = Date.now,
    attachmentStore = null,
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
    if (!ownerUserId) throw new Error('local connector owner user ID is required')
    this.#ownerUserId = String(ownerUserId)
    this.#privateChatIds = new Set([...privateChatIds].map(String))
    this.#repairChatIds = new Set([...repairChatIds].map(String))
    this.#approvalTtlMs = approvalTtlMs
    this.#clock = clock
    if (attachmentStore) {
      this.#attachmentStore = attachmentStore
      this.#attachmentReceiver = new RelayAttachmentReceiver({ attachmentStore })
    }
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

  #resumeWithConfiguredPolicy() {
    return this.#app.request('thread/resume', {
      threadId: this.#threadId,
      ...(this.#approvalPolicy ? { approvalPolicy: this.#approvalPolicy } : {}),
      ...(this.#approvalPolicy && this.#approvalPolicy !== 'never' ? { approvalsReviewer: 'user' } : {}),
      ...(sandboxMode(this.#sandboxPolicy) ? { sandbox: sandboxMode(this.#sandboxPolicy) } : {}),
    })
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
    const onApprovalRequest = request => this.#schedule(() => this.#handleApprovalRequest(request))
    const onRelayFrame = frame => this.#schedule(() => this.#handleRelayFrame(frame))
    this.#listen(this.#app, 'notification:turn/started', onTurnStarted)
    this.#listen(this.#app, 'notification:item/started', onItemStarted)
    this.#listen(this.#app, 'notification:item/completed', onItemCompleted)
    this.#listen(this.#app, 'notification:turn/completed', onTurnCompleted)
    this.#listen(this.#app, 'request', onApprovalRequest)
    this.#listen(this.#relay, 'frame', onRelayFrame)

    const resumed = await this.#resumeWithConfiguredPolicy()
    if (resumed?.thread?.id !== this.#threadId) throw new Error('Codex app-server resumed a different thread')
    this.#replaceActiveTurns(resumed.thread)
    await this.#relay.connect({
      version: RELAY_PROTOCOL_VERSION,
      type: 'hello',
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
      codexSessionId: this.#codexSessionId,
      acceptingJobs: this.#available(),
      capabilities: this.#attachmentReceiver ? [RELAY_ATTACHMENT_CAPABILITY] : [],
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

    if (
      params.turnId !== this.#currentJob?.turnId
      || this.#currentJob.mixedSource
      || this.#currentJob.awaitingRecord
      || params.item?.type !== 'agentMessage'
      || params.item.phase !== 'commentary'
      || typeof params.item.text !== 'string'
      || !params.item.text.trim()
    ) return

    const output = guardTelegramOutput(
      parseTelegramStructuredOutput(params.item.text),
      this.#currentJob.trust,
    )
    if (output.skipped || output.action !== 'send' || !output.finalText?.trim()) return
    const progressId = params.item.id ?? `progress-${createHash('sha256')
      .update(`${params.turnId}\0${params.item.text}`)
      .digest('hex')
      .slice(0, 32)}`
    this.#send(this.#resultFrame('job_progress', {
      turnId: params.turnId,
      progressId,
      text: output.finalText,
    }))
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
    for (const [approvalId, pending] of this.#pendingApprovals) {
      if (pending.request.params?.turnId !== turn.id) continue
      this.#pendingApprovals.delete(approvalId)
      this.#send({ type: 'approval_cancel', approvalId })
    }
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
        const text = finalText(turn, items)
        if (text === null) {
          this.#send(this.#resultFrame('job_result', {
            turnId: turn.id,
            result: { action: 'skip', reason: 'missing_final_answer' },
          }))
        } else {
          const output = guardTelegramOutput(
            parseTelegramStructuredOutput(text),
            this.#currentJob.trust,
          )
          this.#send(this.#resultFrame('job_result', {
            turnId: turn.id,
            result: output.skipped
              ? { action: 'skip', reason: output.reason }
              : output.action === 'react'
                ? {
                    action: 'react',
                    text: output.finalText,
                    responses: output.responses,
                    reason: output.reason,
                  }
              : {
                  action: 'reply',
                  text: output.finalText,
                  responses: output.responses,
                  reason: output.reason,
                },
          }))
        }
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

  #approvalId(request) {
    const params = request.params ?? {}
    return `approval-${createHash('sha256')
      .update(`${request.method}\0${params.threadId ?? ''}\0${params.turnId ?? ''}\0${request.id}`)
      .digest('hex')
      .slice(0, 32)}`
  }

  #handleApprovalRequest(request) {
    if (!SUPPORTED_APPROVAL_METHODS.has(request.method)) return
    const params = request.params ?? {}
    if (params.threadId !== this.#threadId || !params.turnId) return
    if (this.#currentJob?.turnId === params.turnId && !isInstructionTrust(this.#currentJob.trust)) {
      this.#app.respond(request.id, approvalResponse(request.method, params, false))
      return
    }
    const approvalId = this.#approvalId(request)
    this.#pendingApprovals.set(approvalId, { request })
    this.#send({
      type: 'approval_request',
      approval: {
        approvalId,
        method: request.method,
        threadId: params.threadId,
        turnId: params.turnId,
        detail: approvalDetail(request.method, params),
        expiresAtMs: this.#clock() + this.#approvalTtlMs,
      },
    })
  }

  #handleApprovalResponse(frame) {
    const approvalId = frame.approvalId
    const pending = this.#pendingApprovals.get(approvalId)
    if (!pending) {
      this.#send({ type: 'approval_recorded', approvalId })
      return
    }
    const approved = frame.decision === 'approve'
    if (!approved && frame.decision !== 'deny') throw new Error('relay approval response has an invalid decision')
    const { request } = pending
    this.#app.respond(request.id, approvalResponse(request.method, request.params ?? {}, approved))
    this.#pendingApprovals.delete(approvalId)
    this.#send({ type: 'approval_recorded', approvalId })
  }

  async #handleRelayFrame(frame) {
    if (!frame || frame.version !== RELAY_PROTOCOL_VERSION) throw new Error('unsupported relay protocol version')
    if (frame.type === 'attachment_manifest' || frame.type === 'attachment_chunk') {
      if (!this.#attachmentReceiver) throw new Error('relay attachment store is not configured')
      await this.#attachmentReceiver.handleFrame(frame)
      return
    }
    if (frame.type === 'heartbeat' || frame.type === 'ready') {
      this.emit('relayStatus', {
        status: 'connected',
        remoteNowMs: frame.nowMs ?? null,
      })
      return
    }
    if (frame.type === 'approval_queued') return
    if (frame.type === 'approval_response') {
      this.#handleApprovalResponse(frame)
      return
    }
    if (frame.type === 'error') throw new Error(`VPS relay error: ${frame.message}`)
    if (frame.type === 'job_recorded') {
      if (!this.#recordedMatches(frame)) return
      const restorePermissions = !isInstructionTrust(this.#currentJob.trust)
      const paths = this.#currentJob.jobs.flatMap(job => (job.payload?.attachments ?? [])
        .map(attachment => attachment.localPath)
        .filter(Boolean))
      if (this.#attachmentStore?.remove) {
        await Promise.allSettled(paths.map(path => this.#attachmentStore.remove(path)))
      }
      this.#currentJob = null
      if (restorePermissions) await this.#resumeWithConfiguredPolicy()
      this.#send({ type: 'heartbeat', acceptingJobs: this.#available() })
      return
    }

    const materializedFrame = frame.type === 'job_batch' && this.#attachmentReceiver
      ? { ...frame, batch: this.#attachmentReceiver.materializeBatch(frame.batch) }
      : frame
    const inbound = normalizeInbound(materializedFrame)
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
      trust: classifyTelegramJobs(
        inbound.jobs,
        this.#ownerUserId,
        this.#privateChatIds,
        this.#repairChatIds,
      ),
      turnId: null,
      awaitingRecord: false,
      clientUserMessageId,
      mixedSource: false,
    }
    this.#send({ type: 'heartbeat', acceptingJobs: false })
    try {
      const instructionSource = isInstructionTrust(this.#currentJob.trust)
      const telegramMessages = inbound.jobs.map(job => job.payload?.telegramContext ?? {})
      const response = await this.#app.request('turn/start', {
        threadId: this.#threadId,
        input: batchInput(inbound.jobs, this.#currentJob.trust),
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
            value: `${externalFeedTag(this.#currentJob.trust)} This turn originated from Telegram. Turns without this marker originate from the terminal or another local client.`,
          },
          telegram_trust_policy: {
            kind: 'application',
            value: TELEGRAM_TRUST_POLICIES[this.#currentJob.trust],
          },
          telegram_output_contract: { kind: 'application', value: TELEGRAM_BATCH_OUTPUT_INSTRUCTIONS },
        },
        ...(instructionSource
          ? (this.#approvalPolicy ? { approvalPolicy: this.#approvalPolicy } : {})
          : { approvalPolicy: 'never' }),
        ...(instructionSource
          ? (this.#sandboxPolicy ? { sandboxPolicy: this.#sandboxPolicy } : {})
          : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
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
    for (const approvalId of this.#pendingApprovals.keys()) {
      try { this.#send({ type: 'approval_cancel', approvalId }) } catch {}
    }
    this.#pendingApprovals.clear()
    this.#attachmentReceiver?.clear()
    await this.#relay.close()
  }
}
