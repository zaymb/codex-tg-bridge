import { normalizeUpdate } from './update-normalizer.mjs'

export const RELAY_JOB_TTL_MS = 86_400_000

function eventText(update) {
  if (update.message) {
    const text = update.message.text ?? update.message.caption ?? ''
    const prefix = update.type.startsWith('edited_') ? '[Telegram edited message]\n' : ''
    return `${prefix}${text}`.trim()
  }
  if (update.reaction) {
    const added = update.reaction.added?.map(item => item.emoji ?? item.customEmojiId ?? item.type).join(', ') || 'none'
    const removed = update.reaction.removed?.map(item => item.emoji ?? item.customEmojiId ?? item.type).join(', ') || 'none'
    return `Telegram reaction event on bot message ${update.reaction.messageId}. Added: ${added}. Removed: ${removed}.`
  }
  return `Telegram ${update.type} event.`
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

export class RelayDispatcher {
  #state
  #policy
  #sessionLabel
  #workerId
  #updateLeaseMs
  #clock

  constructor({
    stateStore,
    engagementPolicy,
    sessionLabel,
    workerId = `relay-dispatcher-${process.pid}`,
    updateLeaseMs = 120_000,
    clock = Date.now,
  }) {
    if (!sessionLabel) throw new Error('relay session label is required')
    this.#state = stateStore
    this.#policy = engagementPolicy
    this.#sessionLabel = sessionLabel
    this.#workerId = workerId
    this.#updateLeaseMs = updateLeaseMs
    this.#clock = clock
  }

  async drainOnce({ limit = 16 } = {}) {
    this.#state.recoverExpiredLeases(this.#clock())
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

  #recordApprovedUpdate(update, row) {
    if (!this.#state.getApprovedChat(update.conversationKey)) {
      this.#state.upsertApprovedChat({
        conversationKey: update.conversationKey,
        telegramChatId: update.chat.id,
        title: update.chat.title,
        kind: update.message?.threadId ? 'forum_topic' : update.chat.type,
        nowMs: this.#clock(),
      })
    }
    if (!update.message) return
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

  async processClaimedUpdate(row) {
    try {
      const update = normalizeUpdate(row.raw)
      const decision = this.#policy.evaluate(update)
      if (decision.action !== 'turn') {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: decision.action, reason: decision.reason }
      }

      const expiresAtMs = row.createdAtMs + RELAY_JOB_TTL_MS
      if (expiresAtMs <= this.#clock()) {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'expired' }
      }

      this.#recordApprovedUpdate(update, row)
      this.#state.enqueueRelayJob({
        jobId: `telegram:${update.updateId}`,
        sourceType: 'telegram',
        sourceId: update.updateId,
        conversationKey: update.conversationKey,
        sessionLabel: this.#sessionLabel,
        payload: {
          text: eventText(update),
          telegramContext: {
            updateId: update.updateId,
            updateType: update.type,
            chatId: update.chat.id,
            conversationKey: update.conversationKey,
            messageId: messageIdForReply(update),
            senderId: update.actor?.id ?? null,
            senderIsBot: update.actor?.isBot ?? false,
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
