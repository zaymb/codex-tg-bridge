import { createHash, randomBytes } from 'node:crypto'

import { splitTelegramText } from './message-format.mjs'
import {
  prepareRelayAttachmentFrames,
  RelayAttachmentPreparationError,
} from './relay-attachment-transfer.mjs'
import { requireTelegramDiceEmoji } from './telegram-dice.mjs'
import { RELAY_RUNTIME_FINGERPRINT } from './runtime-fingerprint.mjs'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_ATTACHMENT_CAPABILITY = 'attachment_transfer_v1'

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}

class InvalidJobResultError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidJobResultError'
  }
}

function invalidResult(message) {
  throw new InvalidJobResultError(message)
}

function batchIdFor(jobs) {
  return `batch:${jobs[0].jobId}:${jobs.at(-1).jobId}`
}

function isInternalSkipMarker(value) {
  return typeof value === 'string' && /^\s*(?:SKIP|\[SKIP\])\s*$/u.test(value)
}

function approvedStandaloneContext(stateStore, conversationKey) {
  const approved = stateStore.getApprovedChat(conversationKey)
  if (!approved) invalidResult('job result standalone target is not an approved conversation')
  let threadId = null
  if (approved.kind === 'forum_topic') {
    const prefix = `${approved.telegramChatId}:`
    if (!conversationKey.startsWith(prefix)) {
      invalidResult('approved forum topic does not match its Telegram chat')
    }
    const rawThreadId = conversationKey.slice(prefix.length)
    if (!/^\d+$/u.test(rawThreadId) || Number(rawThreadId) <= 0) {
      invalidResult('approved forum topic has an invalid thread ID')
    }
    threadId = rawThreadId
  }
  return {
    conversationKey,
    chatId: approved.telegramChatId,
    threadId,
    messageId: null,
  }
}

function outboundActions(stateStore, batchId, jobs, result, nowMs) {
  if (result.action === 'skip') return []
  if (result.action !== 'targeted' || result.text !== '') {
    invalidResult('job result must be targeted with empty root text, or skip')
  }
  const contexts = jobs.map(job => job.payload?.telegramContext)
  if (contexts.some(context => !context?.chatId || !context?.conversationKey)) {
    throw new Error('relay batch is missing Telegram reply context')
  }
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]
    const context = contexts[index]
    const expectedKey = context.threadId === null || context.threadId === undefined
      ? String(context.chatId)
      : `${context.chatId}:${context.threadId}`
    if (context.conversationKey !== job.conversationKey || expectedKey !== job.conversationKey) {
      throw new Error('relay job Telegram reply context does not match its conversation')
    }
  }
  const byTarget = new Map()
  for (const context of contexts.filter(context => context.messageId)) {
    const messageId = String(context.messageId)
    byTarget.set(`${context.conversationKey}\0${messageId}`, context)
  }
  const targeted = Array.isArray(result.responses) ? result.responses : []
  if (targeted.length === 0) invalidResult('targeted job result requires at least one response')
  const seen = new Set()
  const selected = (targeted.length > 0
      ? targeted.map(response => {
        const requestedAction = response.action
        if (!['send', 'reply', 'react', 'dice'].includes(requestedAction)) {
          invalidResult('job result targeted action must be send, reply, react, or dice')
        }
        if (typeof response.conversationKey !== 'string' || !response.conversationKey) {
          invalidResult('job result targeted response requires conversationKey')
        }
        if (requestedAction === 'send') {
          if (
            typeof response.conversationKey !== 'string'
            || !response.conversationKey
            || response.messageId !== null
          ) {
            invalidResult('job result standalone target requires conversationKey and messageId=null')
          }
          const targetKey = `${response.conversationKey}\0send`
          if (seen.has(targetKey)) invalidResult('job result contains a duplicate standalone target')
          seen.add(targetKey)
          if (typeof response.text !== 'string' || !response.text.trim()) {
            invalidResult('job result targeted response text must be non-empty')
          }
          return {
            context: approvedStandaloneContext(stateStore, response.conversationKey),
            text: response.text,
            action: requestedAction,
            isBig: response.isBig === true,
          }
        }
        const messageId = typeof response?.messageId === 'string' ? response.messageId : ''
        const conversationKey = response.conversationKey
        const context = byTarget.get(`${conversationKey}\0${messageId}`)
        if (!context) invalidResult('job result response target is not in the current batch')
        const targetKey = `${context.conversationKey}\0${messageId}`
        if (seen.has(targetKey)) invalidResult('job result contains a duplicate response target')
        seen.add(targetKey)
        if (typeof response.text !== 'string' || !response.text.trim()) {
          invalidResult('job result targeted response text must be non-empty')
        }
        return {
          context,
          text: response.text,
          action: requestedAction,
          wasReply: requestedAction === 'reply',
          isBig: response.isBig === true,
        }
      })
    : [])
    .filter(response => !response.wasReply || !isInternalSkipMarker(response.text))
  if (selected.length === 0) return []
  if (selected.some(response => !response.text.trim())) {
    invalidResult('job result must contain a non-empty reply or targeted responses')
  }
  const group = `relay-batch:${batchId}`
  const actions = []
  for (const response of selected) {
    if (response.action === 'react') {
      if (!response.context.messageId) throw new Error('Telegram reaction requires a message target')
      actions.push({
        actionId: `${group}:${String(actions.length).padStart(4, '0')}`,
        conversationKey: response.context.conversationKey,
        actionType: 'react',
        payload: {
          chatId: response.context.chatId,
          threadId: response.context.threadId ?? null,
          messageId: response.context.messageId,
          reaction: { type: 'emoji', emoji: response.text.trim() },
          isBig: response.isBig === true,
        },
        sequenceGroup: group,
        sequenceIndex: actions.length,
        nowMs,
      })
      continue
    }
    if (response.action === 'dice') {
      actions.push({
        actionId: `${group}:${String(actions.length).padStart(4, '0')}`,
        conversationKey: response.context.conversationKey,
        actionType: 'send_dice',
        payload: {
          chatId: response.context.chatId,
          threadId: response.context.threadId ?? null,
          replyToMessageId: response.context.messageId ?? null,
          emoji: requireTelegramDiceEmoji(response.text.trim()),
        },
        sequenceGroup: group,
        sequenceIndex: actions.length,
        nowMs,
      })
      continue
    }
    const chunks = splitTelegramText(response.text)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const text = chunks[chunkIndex]
      const index = actions.length
      const first = chunkIndex === 0
      actions.push({
        actionId: `${group}:${String(index).padStart(4, '0')}`,
        conversationKey: response.context.conversationKey,
        actionType: first && response.context.messageId ? 'reply' : 'send_text',
        payload: {
          chatId: response.context.chatId,
          messageId: first && response.context.messageId ? response.context.messageId : null,
          threadId: response.context.threadId ?? null,
          text,
        },
        sequenceGroup: group,
        sequenceIndex: index,
        nowMs,
      })
    }
  }
  return actions
}

export class RelayProtocolSession {
  #state
  #sessionLabel
  #writeFrame
  #clock
  #leaseMs
  #jobLeaseMs
  #frameMaxBytes
  #coalesceQuietMs
  #coalesceMaxMs
  #connectorId = null
  #codexSessionId = null
  #inflightBatch = null
  #inflightAttachmentPaths = []
  #inflightProgressActionIds = new Set()
  #inflightApprovalId = null
  #inflightInterruptId = null
  #inflightDeliveryReceiptId = null
  #acceptingJobs = false
  #capabilities = new Set()
  #closed = false
  #removeAttachment
  #transportControl
  #disengageNotified = false
  #runtimeFingerprint

  constructor({
    stateStore,
    sessionLabel,
    writeFrame,
    clock = Date.now,
    leaseMs = 20_000,
    jobLeaseMs = 120_000,
    frameMaxBytes = 262_144,
    coalesceQuietMs = 0,
    coalesceMaxMs = 0,
    removeAttachment = null,
    transportControl = null,
    runtimeFingerprint = RELAY_RUNTIME_FINGERPRINT,
  }) {
    this.#state = stateStore
    this.#sessionLabel = sessionLabel
    this.#writeFrame = writeFrame
    this.#clock = clock
    this.#leaseMs = leaseMs
    this.#jobLeaseMs = jobLeaseMs
    this.#frameMaxBytes = frameMaxBytes
    this.#coalesceQuietMs = coalesceQuietMs
    this.#coalesceMaxMs = coalesceMaxMs
    this.#removeAttachment = removeAttachment
    this.#transportControl = transportControl
    this.#runtimeFingerprint = runtimeFingerprint
  }

  get ready() {
    return this.#connectorId !== null && !this.#closed
  }

  async #write(frame) {
    const versioned = { version: RELAY_PROTOCOL_VERSION, ...frame }
    if (Buffer.byteLength(JSON.stringify(versioned)) > this.#frameMaxBytes) {
      throw new Error('relay frame exceeds maximum size')
    }
    await this.#writeFrame(versioned)
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
      await this.#write({ type: 'heartbeat', nowMs: this.#clock() })
      return
    }
    if (frame.type === 'job_accepted') return this.#handleAccepted(frame)
    if (frame.type === 'job_deferred') return this.#handleDeferred(frame)
    if (frame.type === 'job_progress') return this.#handleProgress(frame)
    if (frame.type === 'job_result') return this.#handleResult(frame)
    if (frame.type === 'job_failed') return this.#handleFailed(frame)
    if (frame.type === 'approval_request') return this.#handleApprovalRequest(frame)
    if (frame.type === 'approval_recorded') return this.#handleApprovalRecorded(frame)
    if (frame.type === 'approval_cancel') return this.#handleApprovalCancel(frame)
    if (frame.type === 'interrupt_recorded') return this.#handleInterruptRecorded(frame)
    if (frame.type === 'delivery_recorded') return this.#handleDeliveryRecorded(frame)
    throw new Error(`unsupported relay frame type: ${frame.type}`)
  }

  async #handleHello(frame) {
    if (frame.type !== 'hello') throw new Error('hello must be the first relay frame')
    const sessionLabel = requireText(frame.sessionLabel, 'sessionLabel')
    if (sessionLabel !== this.#sessionLabel) throw new Error('relay session label does not match')
    if (frame.runtimeFingerprint !== this.#runtimeFingerprint) {
      throw new Error('relay runtime fingerprint mismatch')
    }
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
    const requested = Array.isArray(frame.capabilities) ? frame.capabilities : []
    if (requested.some(value => typeof value !== 'string')) throw new Error('relay capabilities must be strings')
    this.#capabilities = new Set(requested.filter(value => value === RELAY_ATTACHMENT_CAPABILITY))
    await this.#write({
      type: 'ready',
      sessionLabel,
      leaseMs: this.#leaseMs,
      runtimeFingerprint: this.#runtimeFingerprint,
      capabilities: [...this.#capabilities],
    })
  }

  async claimOnce() {
    if (!this.ready) return false
    if (this.#inflightBatch) {
      const jobs = this.#inflightBatch.jobs.map(job => this.#state.getRelayJob(job.jobId))
      const nowMs = this.#clock()
      if (jobs.every(job => (
        job?.status === 'leased'
        && job.leaseOwner === this.#connectorId
        && job.leaseExpiresAtMs <= nowMs
      ))) {
        throw new Error('relay pre-acceptance job lease expired')
      }
    }
    if (!this.#state.ownsRelaySession({
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
    })) throw new Error('relay session lease was lost')
    const disengageReadyAt = this.#transportControl?.disengageReadyAt() ?? null
    if (disengageReadyAt !== null) {
      if (this.#disengageNotified) return false
      await this.#write({ type: 'transport_disengaged', atMs: disengageReadyAt })
      this.#disengageNotified = true
      this.#acceptingJobs = false
      return true
    }
    if (!this.#inflightInterruptId) {
      const interrupt = this.#transportControl?.nextInterrupt() ?? null
      if (interrupt) {
        this.#inflightInterruptId = interrupt.requestId
        await this.#write({
          type: 'interrupt_request',
          requestId: interrupt.requestId,
          conversationKey: interrupt.conversationKey,
          ...(interrupt.action ? { action: interrupt.action } : {}),
          ...(interrupt.target ? { target: interrupt.target } : {}),
        })
        return true
      }
    }
    if (this.#inflightInterruptId) return false
    if (!this.#inflightDeliveryReceiptId) {
      const receipt = this.#state.nextRelayDeliveryReceipt({
        sessionLabel: this.#sessionLabel,
        codexSessionId: this.#codexSessionId,
      })
      if (receipt) {
        this.#inflightDeliveryReceiptId = receipt.receiptId
        await this.#write({
          type: 'delivery_receipt',
          receiptId: receipt.receiptId,
          batchId: receipt.batchId,
          jobIds: receipt.jobIds,
          status: receipt.status,
          actions: receipt.actions,
        })
        return true
      }
    }
    if (this.#inflightDeliveryReceiptId) return false
    if (!this.#inflightApprovalId) {
      const approval = this.#state.nextRelayApprovalResponse({
        sessionLabel: this.#sessionLabel,
        codexSessionId: this.#codexSessionId,
        nowMs: this.#clock(),
      })
      if (approval) {
        this.#inflightApprovalId = approval.approvalId
        await this.#write({
          type: 'approval_response',
          approvalId: approval.approvalId,
          decision: approval.state === 'approved' ? 'approve' : 'deny',
          reason: approval.state,
        })
        return true
      }
    }
    if (this.#inflightApprovalId || !this.#acceptingJobs || this.#inflightBatch) return false
    const jobs = this.#state.claimRelayJobBatch({
      sessionLabel: this.#sessionLabel,
      connectorId: this.#connectorId,
      maxBatchBytes: this.#frameMaxBytes,
      leaseMs: this.#jobLeaseMs,
      nowMs: this.#clock(),
      coalesceQuietMs: this.#coalesceQuietMs,
      coalesceMaxMs: this.#coalesceMaxMs,
      allowAttachments: this.#capabilities.has(RELAY_ATTACHMENT_CAPABILITY),
    })
    if (jobs.length === 0) return false
    const sourceBatch = { batchId: batchIdFor(jobs), jobs }
    let prepared
    try {
      prepared = await prepareRelayAttachmentFrames(sourceBatch, {
        frameMaxBytes: this.#frameMaxBytes,
      })
    } catch (error) {
      const failingJobId = error instanceof RelayAttachmentPreparationError
        && jobs.some(job => job.jobId === error.jobId)
        ? error.jobId
        : null
      const failed = failingJobId
        ? this.#state.failRelayJob({
            jobId: failingJobId,
            error: error.message,
            connectorId: this.#connectorId,
            nowMs: this.#clock(),
          })
        : this.#state.failRelayJobBatch({
            jobIds: jobs.map(job => job.jobId),
            error: error.message,
            connectorId: this.#connectorId,
            nowMs: this.#clock(),
          })
      if (!failed) throw new Error('invalid relay attachment job could not be quarantined')
      const remainingJobIds = failingJobId
        ? jobs.filter(job => job.jobId !== failingJobId).map(job => job.jobId)
        : []
      if (remainingJobIds.length > 0 && !this.#state.releaseRelayJobBatch({
        jobIds: remainingJobIds,
        connectorId: this.#connectorId,
        nowMs: this.#clock(),
      })) throw new Error('valid relay jobs could not be released after attachment quarantine')
      return true
    }
    const batch = prepared.batch
    const frame = { type: 'job_batch', batch }
    if (Buffer.byteLength(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, ...frame })) > this.#frameMaxBytes) {
      if (!this.#state.failRelayJobBatch({
        jobIds: jobs.map(job => job.jobId),
        error: 'relay batch exceeds maximum frame size',
        connectorId: this.#connectorId,
        nowMs: this.#clock(),
      })) throw new Error('oversized relay batch could not be quarantined')
      return true
    }
    this.#inflightBatch = batch
    this.#inflightAttachmentPaths = prepared.sourcePaths
    this.#inflightProgressActionIds.clear()
    this.#acceptingJobs = false
    for (const attachmentFrame of prepared.frames) await this.#write(attachmentFrame)
    await this.#write(frame)
    return true
  }

  #requireInflight(frame) {
    const batchId = requireText(frame.batchId, 'batchId')
    if (batchId !== this.#inflightBatch?.batchId) throw new Error('relay frame does not match the inflight batch')
    return this.#inflightBatch
  }

  async #handleAccepted(frame) {
    const batch = this.#requireInflight(frame)
    const threadId = requireText(frame.threadId, 'threadId')
    const turnId = requireText(frame.turnId, 'turnId')
    if (!this.#state.acceptRelayJobBatch({
      jobIds: batch.jobs.map(job => job.jobId),
      connectorId: this.#connectorId,
      codexSessionId: this.#codexSessionId,
      threadId,
      turnId,
      nowMs: this.#clock(),
    })) throw new Error('relay batch could not be accepted')
    await this.#cleanupInflightAttachments()
  }

  async #cleanupInflightAttachments() {
    const paths = this.#inflightAttachmentPaths
    this.#inflightAttachmentPaths = []
    if (!this.#removeAttachment || paths.length === 0) return
    await Promise.allSettled(paths.map(path => this.#removeAttachment(path)))
  }

  async #handleDeferred(frame) {
    const batch = this.#requireInflight(frame)
    requireText(frame.reason, 'reason')
    if (!this.#state.releaseRelayJobBatch({
      jobIds: batch.jobs.map(job => job.jobId),
      connectorId: this.#connectorId,
      nowMs: this.#clock(),
    })) throw new Error('relay batch could not be deferred')
    this.#inflightBatch = null
    this.#inflightAttachmentPaths = []
    await this.#write({
      type: 'job_recorded',
      batchId: batch.batchId,
      jobIds: batch.jobs.map(job => job.jobId),
    })
  }

  #handleProgress(frame) {
    const batch = this.#requireInflight(frame)
    const turnId = requireText(frame.turnId, 'turnId')
    const progressId = requireText(frame.progressId, 'progressId')
    const text = requireText(frame.text, 'text')
    const jobs = batch.jobs.map(job => this.#state.getRelayJob(job.jobId))
    if (jobs.some(job => job?.status !== 'accepted' || job.turnId !== turnId)) {
      throw new Error('relay progress does not match the accepted turn')
    }
    const progressKey = createHash('sha256')
      .update(`${turnId}\0${progressId}`)
      .digest('hex')
      .slice(0, 32)
    const actions = outboundActions(
      this.#state,
      `${batch.batchId}:progress:${progressKey}`,
      jobs,
      {
        action: 'targeted',
        text: '',
        responses: [{
          conversationKey: requireText(frame.conversationKey, 'conversationKey'),
          action: frame.action ?? 'reply',
          messageId: frame.action === 'send'
            ? null
            : requireText(frame.messageId, 'messageId'),
          text,
        }],
      },
      this.#clock(),
    )
    for (const action of actions) {
      action.payload.deliveryClass = 'progress'
      this.#state.createOutboundAction(action)
      this.#inflightProgressActionIds.add(action.actionId)
    }
  }

  async #handleResult(frame) {
    const batch = this.#requireInflight(frame)
    const turnId = requireText(frame.turnId, 'turnId')
    const jobs = batch.jobs.map(job => this.#state.getRelayJob(job.jobId))
    if (jobs.some(job => job?.status !== 'accepted' || job.turnId !== turnId)) {
      throw new Error('relay result does not match the accepted turn')
    }
    let actions
    try {
      actions = outboundActions(
        this.#state,
        batch.batchId,
        jobs,
        frame.result ?? {},
        this.#clock(),
      )
    } catch (error) {
      if (!(error instanceof InvalidJobResultError)) throw error
      if (!this.#state.failRelayJobBatch({
        jobIds: jobs.map(job => job.jobId),
        error: error.message,
        turnId,
        nowMs: this.#clock(),
      })) throw new Error('invalid relay result could not be failed atomically')
      this.#state.supersedeOutboundActions({
        actionIds: [...this.#inflightProgressActionIds],
        reason: 'relay turn ended with an invalid final result',
        nowMs: this.#clock(),
      })
      this.#inflightProgressActionIds.clear()
      this.#inflightBatch = null
      this.#inflightAttachmentPaths = []
      await this.#write({
        type: 'job_recorded',
        batchId: batch.batchId,
        jobIds: jobs.map(job => job.jobId),
        status: 'failed',
        error: error.message,
      })
      return
    }
    if (!this.#state.finalizeRelayJobBatch({
      jobIds: jobs.map(job => job.jobId),
      turnId,
      result: frame.result,
      outboundActions: actions,
      supersedeActionIds: [...this.#inflightProgressActionIds],
      deliveryBatchId: batch.batchId,
      nowMs: this.#clock(),
    })) throw new Error('relay result could not be recorded')
    this.#inflightProgressActionIds.clear()
    this.#inflightBatch = null
    this.#inflightAttachmentPaths = []
    await this.#write({
      type: 'job_recorded',
      batchId: batch.batchId,
      jobIds: jobs.map(job => job.jobId),
      status: 'completed',
    })
  }

  async #handleFailed(frame) {
    const batch = this.#requireInflight(frame)
    const error = requireText(frame.error, 'error')
    const jobs = batch.jobs.map(job => this.#state.getRelayJob(job.jobId))
    const accepted = jobs.every(job => job?.status === 'accepted')
    if (!this.#state.failRelayJobBatch({
      jobIds: jobs.map(job => job.jobId),
      error,
      connectorId: accepted ? null : this.#connectorId,
      turnId: accepted ? frame.turnId : null,
      nowMs: this.#clock(),
    })) throw new Error('relay failure does not match the active batch')
    this.#state.supersedeOutboundActions({
      actionIds: [...this.#inflightProgressActionIds],
      reason: 'relay turn ended before a final result',
      nowMs: this.#clock(),
    })
    this.#inflightProgressActionIds.clear()
    this.#inflightBatch = null
    this.#inflightAttachmentPaths = []
    await this.#write({
      type: 'job_recorded',
      batchId: batch.batchId,
      jobIds: jobs.map(job => job.jobId),
      status: 'failed',
      error,
    })
  }

  async #handleApprovalRequest(frame) {
    const approval = frame.approval ?? {}
    const approvalId = requireText(approval.approvalId, 'approval.approvalId')
    if (!/^[A-Za-z0-9:_-]{8,128}$/u.test(approvalId)) throw new Error('invalid relay approval ID')
    const method = requireText(approval.method, 'approval.method')
    if (!APPROVAL_METHODS.has(method)) throw new Error('unsupported relay approval method')
    const threadId = requireText(approval.threadId, 'approval.threadId')
    if (threadId !== this.#codexSessionId) throw new Error('relay approval thread does not match the connected session')
    const turnId = requireText(approval.turnId, 'approval.turnId')
    const detail = requireText(approval.detail, 'approval.detail').slice(0, 3_000)
    const ownerUserId = this.#state.getSetting('telegram_owner_user_id')
    if (!ownerUserId) throw new Error('Telegram owner is not configured for relay approvals')
    const expiresAtMs = Number(approval.expiresAtMs)
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= this.#clock()) {
      throw new Error('relay approval expiry is invalid')
    }

    let stored = this.#state.getRelayApproval(approvalId)
    if (!stored) {
      const callbackToken = randomBytes(24).toString('base64url')
      stored = this.#state.createRelayApproval({
        approvalId,
        sessionLabel: this.#sessionLabel,
        connectorId: this.#connectorId,
        codexSessionId: this.#codexSessionId,
        method,
        threadId,
        turnId,
        ownerUserId,
        detail,
        callbackToken,
        tokenHash: hashToken(callbackToken),
        expiresAtMs,
        nowMs: this.#clock(),
      })
    } else if (stored.connectorId !== this.#connectorId) {
      stored = this.#state.rebindRelayApproval({
        approvalId,
        connectorId: this.#connectorId,
        nowMs: this.#clock(),
      })
    }
    if (
      stored.sessionLabel !== this.#sessionLabel
      || stored.codexSessionId !== this.#codexSessionId
      || stored.method !== method
      || stored.threadId !== threadId
      || stored.turnId !== turnId
      || stored.ownerUserId !== ownerUserId
    ) throw new Error('relay approval ID was reused with different context')

    const actionId = `relay-approval:${approvalId}`
    this.#state.createOutboundAction({
      actionId,
      conversationKey: ownerUserId,
      actionType: 'send_text',
      payload: {
        chatId: ownerUserId,
        text: `${stored.detail}\n\nSession: ${this.#sessionLabel}`,
        replyMarkup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `ra:${stored.callbackToken}:approve` },
            { text: 'Deny', callback_data: `ra:${stored.callbackToken}:deny` },
          ]],
        },
      },
      nowMs: this.#clock(),
    })
    await this.#write({ type: 'approval_queued', approvalId })
  }

  #handleApprovalRecorded(frame) {
    const approvalId = requireText(frame.approvalId, 'approvalId')
    if (approvalId !== this.#inflightApprovalId) throw new Error('relay approval acknowledgement does not match inflight approval')
    if (!this.#state.markRelayApprovalDelivered(approvalId, this.#clock())) {
      throw new Error('relay approval response could not be recorded')
    }
    this.#inflightApprovalId = null
  }

  #handleInterruptRecorded(frame) {
    const requestId = requireText(frame.requestId, 'requestId')
    if (requestId !== this.#inflightInterruptId) {
      throw new Error('interrupt acknowledgement does not match inflight request')
    }
    if (!['interrupted', 'peer_interrupted', 'no_active_turn', 'resumed'].includes(frame.status)) {
      throw new Error('interrupt acknowledgement has an invalid status')
    }
    if (!this.#transportControl?.completeInterrupt(requestId, this.#clock())) {
      throw new Error('interrupt request could not be completed')
    }
    this.#inflightInterruptId = null
  }

  #handleDeliveryRecorded(frame) {
    const receiptId = requireText(frame.receiptId, 'receiptId')
    if (receiptId !== this.#inflightDeliveryReceiptId) {
      throw new Error('delivery acknowledgement does not match inflight receipt')
    }
    if (!this.#state.markRelayDeliveryReceiptDelivered(receiptId, this.#clock())) {
      throw new Error('delivery receipt could not be recorded')
    }
    this.#inflightDeliveryReceiptId = null
  }

  #handleApprovalCancel(frame) {
    const approvalId = requireText(frame.approvalId, 'approvalId')
    this.#state.cancelRelayApproval(approvalId, this.#clock())
    if (this.#inflightApprovalId === approvalId) this.#inflightApprovalId = null
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#inflightBatch) {
      const jobs = this.#inflightBatch.jobs.map(job => this.#state.getRelayJob(job.jobId))
      if (jobs.every(job => job?.status === 'accepted' && job.turnId)) {
        const turnIds = new Set(jobs.map(job => job.turnId))
        if (turnIds.size === 1) {
          this.#state.failRelayJobBatch({
            jobIds: jobs.map(job => job.jobId),
            error: 'relay disconnected before recording a result',
            turnId: jobs[0].turnId,
            nowMs: this.#clock(),
          })
        }
      } else if (jobs.every(job => job?.status === 'leased')) {
        this.#state.releaseRelayJobBatch({
          jobIds: jobs.map(job => job.jobId),
          connectorId: this.#connectorId,
          nowMs: this.#clock(),
        })
      }
      this.#state.supersedeOutboundActions({
        actionIds: [...this.#inflightProgressActionIds],
        reason: 'relay session closed before a final result',
        nowMs: this.#clock(),
      })
      this.#inflightProgressActionIds.clear()
      this.#inflightBatch = null
      this.#inflightAttachmentPaths = []
    }
    if (this.#connectorId) {
      this.#state.disconnectRelaySession({
        sessionLabel: this.#sessionLabel,
        connectorId: this.#connectorId,
        nowMs: this.#clock(),
      })
    }
  }
}
