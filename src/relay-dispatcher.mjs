import { createHash } from 'node:crypto'

import { classifyImageAttachment } from './image-attachment.mjs'
import { DEFAULT_RELAY_ATTACHMENT_MAX_BYTES } from './relay-attachment-transfer.mjs'
import { normalizeUpdate } from './update-normalizer.mjs'
import { resolveTopicName } from './topic-map.mjs'
import {
  AWAY_ACK_PREFIX,
  AWAY_INVALID_PREFIX,
  AWAY_INVALID_REPLY,
  DISENGAGE_ACK_PREFIX,
  DISENGAGE_REPLY,
  INTERRUPT_ACK_PREFIX,
  RESUME_ACK_PREFIX,
  RESUME_REPLY,
  interruptReply,
  isAwayReleaseMention,
  parseTransportCommand,
} from './transport-control.mjs'

export const RELAY_JOB_TTL_MS = 86_400_000

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function eventText(update) {
  if (update.message) {
    const text = update.message.text ?? update.message.caption ?? ''
    const prefix = update.type.startsWith('edited_') ? '[Telegram edited message]\n' : ''
    if (update.message.dice) {
      return `${prefix}Telegram dice result: ${update.message.dice.emoji} = ${update.message.dice.value}.`.trim()
    }
    return `${prefix}${text}`.trim()
  }
  if (update.reaction) {
    const added = update.reaction.added?.map(item => item.emoji ?? item.customEmojiId ?? item.type).join(', ') || 'none'
    const removed = update.reaction.removed?.map(item => item.emoji ?? item.customEmojiId ?? item.type).join(', ') || 'none'
    return `Telegram reaction event on bot message ${update.reaction.messageId}. Added: ${added}. Removed: ${removed}.`
  }
  return `Telegram ${update.type} event.`
}

function shouldBypassCoalescing(update, ownerUserId) {
  return update.type === 'message'
    && update.chat?.type === 'private'
    && update.chat.id === ownerUserId
    && update.actor?.id === ownerUserId
    && typeof update.message?.text === 'string'
    && update.message.text.trimStart().startsWith('/')
}

function topicId(update) {
  if (update.message?.threadId) return update.message.threadId
  const key = update.conversationKey ?? ''
  const index = key.lastIndexOf(':')
  return index === -1 ? null : key.slice(index + 1)
}

function messageIdForReply(update) {
  return update.message?.id ?? update.reaction?.messageId ?? null
}

function replyContext(update) {
  const reply = update.message?.replyTo
  if (!reply) return null
  return {
    messageId: reply.messageId,
    senderId: reply.actor?.id ?? null,
    senderIsBot: reply.actor?.isBot ?? false,
    senderUsername: reply.actor?.username ?? null,
    senderDisplayName: reply.actor?.displayName ?? null,
    text: reply.text ?? reply.caption ?? null,
  }
}

export class RelayDispatcher {
  #state
  #policy
  #sessionLabel
  #telegram
  #attachmentStore
  #topicNames
  #ownerUserId
  #workerId
  #updateLeaseMs
  #clock
  #control
  #botUsername

  constructor({
    stateStore,
    engagementPolicy,
    sessionLabel,
    telegramClient = null,
    attachmentStore = null,
    topicNames = new Map(),
    ownerUserId,
    workerId = `relay-dispatcher-${process.pid}`,
    updateLeaseMs = 120_000,
    clock = Date.now,
    transportControl = null,
    botUsername = null,
  }) {
    if (!sessionLabel) throw new Error('relay session label is required')
    if (!ownerUserId) throw new Error('relay owner user ID is required')
    this.#state = stateStore
    this.#policy = engagementPolicy
    this.#sessionLabel = sessionLabel
    this.#telegram = telegramClient
    this.#attachmentStore = attachmentStore
    this.#topicNames = topicNames
    this.#ownerUserId = String(ownerUserId)
    this.#workerId = workerId
    this.#updateLeaseMs = updateLeaseMs
    this.#clock = clock
    this.#control = transportControl
    this.#botUsername = botUsername
  }

  async drainOnce({ limit = 16 } = {}) {
    this.#state.recoverExpiredLeases(this.#clock())
    if (this.#control) {
      this.#control.clearExpiredAway(this.#clock())
      // Disengage (pending or active) stops all fresh intake; pending still
      // lets already-enqueued relay jobs and outbound actions finish elsewhere.
      if (this.#control.isDisengaged() || this.#control.isDisengagePending()) {
        return { claimed: 0, processed: 0, failed: 0 }
      }
      if (this.#control.isAway(this.#clock())) return this.#drainAwayOnce({ limit })
    }
    const rows = this.#state.claimUpdates({
      workerId: this.#workerId,
      limit,
      leaseMs: this.#updateLeaseMs,
      nowMs: this.#clock(),
    })
    const results = []
    for (const row of rows) results.push(await this.processClaimedUpdate(row))
    return {
      claimed: rows.length,
      processed: results.filter(result => result.status === 'completed').length,
      failed: results.filter(result => result.status === 'failed').length,
    }
  }

  // Away mode: ordinary updates stay queued (durable batching in
  // telegram_updates). Only two things are claimed: admin transport commands,
  // and the admin's @bot mention that releases away early. The mention row is
  // released back to the queue untouched so it flushes through the normal
  // pipeline together with the backlog, in natural order.
  async #drainAwayOnce({ limit = 8 } = {}) {
    const context = { ownerUserId: this.#ownerUserId, botUsername: this.#botUsername }
    const rows = this.#state.claimUpdatesMatching({
      workerId: this.#workerId,
      predicate: row => {
        try {
          const update = normalizeUpdate(row.raw)
          return parseTransportCommand(update, context) !== null
            || isAwayReleaseMention(update, context)
        } catch {
          return false
        }
      },
      limit,
      leaseMs: this.#updateLeaseMs,
      nowMs: this.#clock(),
    })
    const results = []
    for (const row of rows) {
      const update = normalizeUpdate(row.raw)
      if (parseTransportCommand(update, context) === null
        && isAwayReleaseMention(update, context)) {
        this.#control.releaseAway(this.#clock())
        this.#state.releaseUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        results.push({ status: 'completed', action: 'away_released' })
        continue
      }
      results.push(await this.processClaimedUpdate(row))
    }
    return {
      claimed: rows.length,
      processed: results.filter(result => result.status === 'completed').length,
      failed: results.filter(result => result.status === 'failed').length,
    }
  }

  async #recordApprovedUpdate(update, row) {
    if (!this.#state.getApprovedChat(update.conversationKey)) {
      this.#state.upsertApprovedChat({
        conversationKey: update.conversationKey,
        telegramChatId: update.chat.id,
        title: update.chat.title,
        kind: update.message?.threadId ? 'forum_topic' : update.chat.type,
        nowMs: this.#clock(),
      })
    }
    if (!update.message) return []
    this.#state.recordMessage({
      updateId: row.updateId,
      conversationKey: update.conversationKey,
      telegramChatId: update.chat.id,
      telegramMessageId: update.message.id,
      senderId: update.actor?.id ?? null,
      messageType: update.type,
      metadata: update,
      nowMs: this.#clock(),
    })
    const attachments = []
    for (const attachment of update.message.attachments ?? []) {
      if (!this.#telegram || !this.#attachmentStore) {
        throw new Error('relay attachment transport is not configured')
      }
      if (Number.isFinite(attachment.fileSize) && attachment.fileSize > DEFAULT_RELAY_ATTACHMENT_MAX_BYTES) {
        throw new Error('Telegram attachment declared size exceeds relay limit')
      }
      const downloaded = await this.#telegram.downloadFile(attachment.fileId, {
        maxBytes: DEFAULT_RELAY_ATTACHMENT_MAX_BYTES,
      })
      const imageInput = classifyImageAttachment(attachment, downloaded.bytes)
      const classified = imageInput ? { ...attachment, ...imageInput } : attachment
      const saved = await this.#attachmentStore.save({
        updateId: row.updateId,
        attachment: classified,
        bytes: downloaded.bytes,
      })
      this.#state.recordAttachment({
        updateId: row.updateId,
        telegramFileId: attachment.fileId,
        telegramUniqueId: attachment.uniqueId,
        localPath: saved.localPath,
        mediaType: attachment.kind,
        byteSize: saved.byteSize,
        sha256: saved.sha256,
        nowMs: this.#clock(),
      })
      attachments.push({ ...classified, ...saved })
    }
    return attachments
  }

  #queueOfflineNotice(update) {
    const session = this.#state.getRelaySession(this.#sessionLabel, this.#clock())
      ?? this.#state.ensureRelaySession(this.#sessionLabel, this.#clock())
    if (session.status !== 'offline') return false
    if (!this.#state.claimOfflineNotice({
      sessionLabel: this.#sessionLabel,
      conversationKey: update.conversationKey,
      nowMs: this.#clock(),
    })) return false

    const actionId = `offline:${this.#sessionLabel}:${session.offlineEpoch}:${update.conversationKey}`
    this.#state.createOutboundAction({
      actionId,
      conversationKey: update.conversationKey,
      actionType: messageIdForReply(update) ? 'reply' : 'send_text',
      payload: {
        chatId: update.chat.id,
        messageId: messageIdForReply(update),
        threadId: topicId(update),
        text: `Codex 会话「${this.#sessionLabel}」当前不在线。`,
      },
      nowMs: this.#clock(),
    })
    return true
  }

  #queueCallbackAnswer(update, row, text, showAlert = false) {
    this.#state.createOutboundAction({
      actionId: `relay-callback:${row.updateId}`,
      conversationKey: this.#ownerUserId,
      actionType: 'answer_callback_query',
      payload: {
        callbackQueryId: update.callback.id,
        text,
        showAlert,
      },
      nowMs: this.#clock(),
    })
  }

  #handleRelayApprovalCallback(update, row) {
    const data = update.callback?.data ?? ''
    const match = data.match(/^ra:([A-Za-z0-9_-]{8,48}):(approve|deny)$/u)
    if (!match) return null
    if (
      update.actor?.id !== this.#ownerUserId
      || update.chat?.type !== 'private'
      || update.chat?.id !== this.#ownerUserId
    ) {
      this.#queueCallbackAnswer(update, row, 'Not authorized', true)
      return { status: 'completed', action: 'approval_rejected', reason: 'not_authorized' }
    }
    const decision = match[2] === 'approve' ? 'approved' : 'denied'
    const resolution = this.#state.resolveRelayApproval({
      tokenHash: hashToken(match[1]),
      ownerUserId: this.#ownerUserId,
      decision,
      nowMs: this.#clock(),
    })
    if (!resolution.resolved) {
      const text = resolution.reason === 'expired' ? 'Approval expired' : 'Approval is no longer active'
      this.#queueCallbackAnswer(update, row, text, true)
      return { status: 'completed', action: 'approval_inactive', reason: resolution.reason }
    }
    this.#queueCallbackAnswer(update, row, decision === 'approved' ? 'Approved' : 'Denied')
    return { status: 'completed', action: decision }
  }

  #queueControlReply(update, actionId, text) {
    this.#state.createOutboundAction({
      actionId,
      conversationKey: update.conversationKey,
      actionType: messageIdForReply(update) ? 'reply' : 'send_text',
      payload: {
        chatId: update.chat.id,
        messageId: messageIdForReply(update),
        threadId: topicId(update),
        text,
      },
      nowMs: this.#clock(),
    })
  }

  // Transport-level slash commands: admin-only, never reach the model. The
  // pending phase is written in the same tick the command is claimed, so new
  // turns are blocked before the ack is even sent (v2.1 race rule).
  #handleTransportCommand(command, update, row) {
    const nowMs = this.#clock()
    if (command.kind === 'away') {
      const ackActionId = `${AWAY_ACK_PREFIX}${row.updateId}`
      const { accepted } = this.#control.requestAway({
        durationMs: command.durationMs,
        ackActionId,
        nowMs,
      })
      if (accepted) {
        this.#queueControlReply(update, ackActionId, `Will be back in ${command.minutes}m.`)
      }
      this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
      return { status: 'completed', action: accepted ? 'away_pending' : 'away_dropped' }
    }
    if (command.kind === 'away_invalid') {
      this.#queueControlReply(update, `${AWAY_INVALID_PREFIX}${row.updateId}`, AWAY_INVALID_REPLY)
      this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
      return { status: 'completed', action: 'away_invalid' }
    }
    if (command.kind === 'disengage') {
      const ackActionId = `${DISENGAGE_ACK_PREFIX}${row.updateId}`
      const { accepted } = this.#control.requestDisengage({ ackActionId, nowMs })
      if (accepted) {
        this.#queueControlReply(update, ackActionId, DISENGAGE_REPLY)
      }
      this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
      return { status: 'completed', action: accepted ? 'disengage_pending' : 'disengage_duplicate' }
    }
    if (command.kind === 'interrupt' || command.kind === 'resume') {
      const action = command.kind === 'resume' ? 'continue' : 'stop'
      const requestId = `${command.kind}:${row.updateId}`
      const { accepted } = this.#control.requestInterrupt({
        requestId,
        conversationKey: update.conversationKey,
        action,
        target: command.target ?? 'all',
        nowMs,
      })
      if (accepted && !(action === 'stop' && command.target === 'laurie')) {
        this.#queueControlReply(
          update,
          `${action === 'stop' ? INTERRUPT_ACK_PREFIX : RESUME_ACK_PREFIX}${row.updateId}`,
          action === 'stop' ? interruptReply(command.target) : RESUME_REPLY,
        )
      }
      this.#state.completeUpdate({
        updateId: row.updateId,
        workerId: this.#workerId,
        nowMs: this.#clock(),
      })
      return {
        status: 'completed',
        action: accepted ? `${command.kind}_pending` : `${command.kind}_duplicate`,
      }
    }
    throw new Error(`unsupported transport command: ${command.kind}`)
  }

  async processClaimedUpdate(row) {
    try {
      const update = normalizeUpdate(row.raw)
      if (this.#control) {
        const command = parseTransportCommand(update, {
          ownerUserId: this.#ownerUserId,
          botUsername: this.#botUsername,
        })
        if (command) return this.#handleTransportCommand(command, update, row)
      }
      if (update.type === 'callback_query') {
        const approval = this.#handleRelayApprovalCallback(update, row)
        if (approval) {
          this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
          return approval
        }
      }
      let knownBotMessage = null
      if (update.reaction) {
        knownBotMessage = this.#state.findSentOutboundMessage(update.chat.id, update.reaction.messageId)
        if (knownBotMessage) update.conversationKey = knownBotMessage.conversationKey
      }
      const decision = this.#policy.evaluate(update, { isKnownBotMessage: Boolean(knownBotMessage) })
      if (decision.action !== 'turn') {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: decision.action, reason: decision.reason }
      }

      const expiresAtMs = row.createdAtMs + RELAY_JOB_TTL_MS
      if (expiresAtMs <= this.#clock()) {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'expired' }
      }

      const attachments = await this.#recordApprovedUpdate(update, row)
      const threadId = topicId(update)
      const threadName = resolveTopicName(this.#topicNames, update.chat.id, threadId)
      this.#state.enqueueRelayJob({
        jobId: `telegram:${update.updateId}`,
        sourceType: 'telegram',
        sourceId: update.updateId,
        conversationKey: update.conversationKey,
        sessionLabel: this.#sessionLabel,
        payload: {
          text: eventText(update),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(shouldBypassCoalescing(update, this.#ownerUserId)
            ? { dispatch: { bypassCoalesce: true } }
            : {}),
          telegramContext: {
            updateId: update.updateId,
            updateType: update.type,
            chatId: update.chat.id,
            ...(update.chat.title ? { chatTitle: update.chat.title } : {}),
            conversationKey: update.conversationKey,
            threadId,
            ...(threadName ? { threadName } : {}),
            messageId: messageIdForReply(update),
            senderId: update.actor?.id ?? null,
            senderIsBot: update.actor?.isBot ?? false,
            senderUsername: update.actor?.username ?? null,
            senderDisplayName: update.actor?.displayName ?? null,
            replyTo: replyContext(update),
          },
        },
        expiresAtMs,
        nowMs: this.#clock(),
      })
      this.#queueOfflineNotice(update)
      this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
      return { status: 'completed', action: 'queued' }
    } catch (error) {
      this.#state.failUpdate({
        updateId: row.updateId,
        workerId: this.#workerId,
        error: error.message,
        retryAtMs: this.#clock() + Math.min(60_000, 1_000 * (2 ** Math.max(0, row.attempts - 1))),
        permanent: row.attempts >= 5,
        nowMs: this.#clock(),
      })
      return { status: 'failed', error }
    }
  }
}
