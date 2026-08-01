import { splitTelegramText } from './message-format.mjs'
import { normalizeUpdate } from './update-normalizer.mjs'
import { readFile } from 'node:fs/promises'
import {
  RateLimitError,
  TelegramApiError,
  TelegramTransportError,
} from './telegram-client.mjs'

class Semaphore {
  #limit
  #active = 0
  #queue = []

  constructor(limit) {
    this.#limit = limit
  }

  async run(task) {
    if (this.#active >= this.#limit) {
      await new Promise(resolve => this.#queue.push(resolve))
    }
    this.#active += 1
    try {
      return await task()
    } finally {
      this.#active -= 1
      this.#queue.shift()?.()
    }
  }
}

function commandName(update) {
  const text = update.message?.text ?? update.message?.caption ?? ''
  return text.match(/^\/(new|stop)(?:@[A-Za-z0-9_]+)?(?:\s|$)/iu)?.[1]?.toLowerCase() ?? null
}

function isOwnerStop(update, ownerUserId) {
  return commandName(update) === 'stop'
    && update.actor?.id === ownerUserId
    && update.chat?.type === 'private'
    && update.chat?.id === ownerUserId
}

function isOwnerCallback(update, ownerUserId) {
  return update.type === 'callback_query'
    && update.actor?.id === ownerUserId
    && update.chat?.type === 'private'
    && update.chat?.id === ownerUserId
}

function hasEquivalentSentResponse(state, turn, response) {
  return (turn.sentActionIds ?? []).some(actionId => {
    const action = state.getOutboundAction(actionId)
    if (action?.status !== 'sent' || action.conversationKey !== response.conversationKey) return false
    if (response.action === 'react') {
      return action.actionType === 'react' && action.payload?.reaction?.emoji === response.text
    }
    if (response.action === 'dice') {
      return action.actionType === 'send_dice' && action.payload?.emoji === response.text
    }
    return ['send_text', 'reply'].includes(action.actionType) && action.payload?.text === response.text
  })
}

function topicId(update) {
  if (update.message?.threadId) return update.message.threadId
  const key = update.conversationKey ?? ''
  const index = key.lastIndexOf(':')
  return index === -1 ? null : key.slice(index + 1)
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

function messageIdForReply(update) {
  return update.message?.id ?? update.reaction?.messageId ?? null
}

export class Dispatcher {
  #state
  #telegram
  #runner
  #approvalRouter
  #policy
  #attachmentStore
  #ownerUserId
  #workerId
  #updateLeaseMs
  #typingIntervalMs
  #clock
  #botIdentity
  #semaphore
  #chains = new Map()

  constructor({
    stateStore,
    telegramClient,
    codexRunner,
    approvalRouter,
    engagementPolicy,
    attachmentStore,
    ownerUserId,
    maxConcurrentTurns = 2,
    workerId = `dispatcher-${process.pid}`,
    updateLeaseMs = 120_000,
    typingIntervalMs = 4_000,
    clock = Date.now,
    botIdentity = null,
  }) {
    this.#state = stateStore
    this.#telegram = telegramClient
    this.#runner = codexRunner
    this.#approvalRouter = approvalRouter
    this.#policy = engagementPolicy
    this.#attachmentStore = attachmentStore
    this.#ownerUserId = String(ownerUserId)
    this.#workerId = workerId
    this.#updateLeaseMs = updateLeaseMs
    this.#typingIntervalMs = typingIntervalMs
    this.#clock = clock
    this.#botIdentity = botIdentity
    this.#semaphore = new Semaphore(maxConcurrentTurns)
  }

  #schedule(key, task) {
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.#semaphore.run(task))
    this.#chains.set(key, current)
    current.finally(() => {
      if (this.#chains.get(key) === current) this.#chains.delete(key)
    }).catch(() => {})
    return current
  }

  async drainOnce({ limit = 16 } = {}) {
    this.#state.recoverExpiredLeases(this.#clock())
    await this.#approvalRouter.expirePending()
    const rows = this.#state.claimUpdates({
      workerId: this.#workerId,
      limit,
      leaseMs: this.#updateLeaseMs,
      nowMs: this.#clock(),
    })
    const scheduled = []
    const preemptiveStops = []
    for (const row of rows) {
      let key = row.conversationKey
      let update = null
      try {
        update = normalizeUpdate(row.raw)
        if (!key) key = update.conversationKey
      } catch {}
      if (update && isOwnerStop(update, this.#ownerUserId)) {
        preemptiveStops.push(row)
      } else {
        scheduled.push(this.#schedule(key ?? `update:${row.updateId}`, () => this.processClaimedUpdate(row)))
      }
    }
    if (preemptiveStops.length > 0) {
      await new Promise(resolve => setImmediate(resolve))
      scheduled.push(...preemptiveStops.map(row => this.processClaimedUpdate(row)))
    }
    const results = await Promise.all(scheduled)
    return {
      claimed: rows.length,
      processed: results.filter(result => result.status === 'completed').length,
      failed: results.filter(result => result.status === 'failed').length,
    }
  }

  async drainControlsOnce({ limit = 8 } = {}) {
    await this.#approvalRouter.expirePending()
    const rows = this.#state.claimUpdatesMatching({
      workerId: this.#workerId,
      predicate: row => {
        try {
          const update = normalizeUpdate(row.raw)
          return isOwnerStop(update, this.#ownerUserId) || isOwnerCallback(update, this.#ownerUserId)
        } catch {
          return false
        }
      },
      scanLimit: null,
      limit,
      leaseMs: this.#updateLeaseMs,
      nowMs: this.#clock(),
    })
    const results = await Promise.all(rows.map(row => this.processClaimedUpdate(row)))
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

    if (update.message) {
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

    const attachments = []
    for (const attachment of update.message?.attachments ?? []) {
      const downloaded = await this.#telegram.downloadFile(attachment.fileId)
      const saved = await this.#attachmentStore.save({
        updateId: row.updateId,
        attachment,
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
      attachments.push({ ...attachment, localPath: saved.localPath })
    }
    return attachments
  }

  async processClaimedUpdate(row) {
    try {
      const update = normalizeUpdate(row.raw)
      let knownBotMessage = null
      if (update.reaction) {
        knownBotMessage = this.#state.findSentOutboundMessage(update.chat.id, update.reaction.messageId)
        if (knownBotMessage) update.conversationKey = knownBotMessage.conversationKey
      }
      const decision = this.#policy.evaluate(update, { isKnownBotMessage: Boolean(knownBotMessage) })

      if (decision.action === 'reject') {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'rejected', reason: decision.reason }
      }
      if (decision.action === 'callback') {
        await this.#approvalRouter.handleCallback(update)
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'callback' }
      }

      const attachments = await this.#recordApprovedUpdate(update, row)
      if (decision.action === 'store') {
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'stored', reason: decision.reason }
      }

      const command = update.actor?.id === this.#ownerUserId ? commandName(update) : null
      if (command === 'new') {
        this.#state.detachThread(update.conversationKey, 'owner requested /new', this.#clock())
        await this.#sendSystemReply(update, row.updateId, 'A new Codex conversation will start with your next message.')
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'new' }
      }
      if (command === 'stop') {
        const interrupted = await this.#runner.interrupt(update.conversationKey)
        await this.#sendSystemReply(update, row.updateId, interrupted ? 'Stopped the active turn.' : 'No active turn.')
        this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
        return { status: 'completed', action: 'stop' }
      }

      const typing = this.#startTyping(update)
      let turn
      try {
        turn = await this.#runner.runTurn({
          conversationKey: update.conversationKey,
          ownerDm: update.chat.type === 'private' && update.actor?.id === this.#ownerUserId,
          text: eventText(update),
          attachments,
          telegramContext: {
            updateId: update.updateId,
            updateType: update.type,
            chatId: update.chat.id,
            conversationKey: update.conversationKey,
            messageId: messageIdForReply(update),
            senderId: update.actor?.id ?? null,
            senderIsBot: update.actor?.isBot ?? false,
          },
          clientUserMessageId: `telegram:${update.updateId}`,
        })
      } finally {
        clearInterval(typing)
      }

      if (turn.contextBreak) {
        await this.#sendContextBreakNotice(update, row.updateId, turn.replacedThreadId)
      }
      let sent = 0
      let equivalentSent = false
      if (!turn.skipped) {
        if (turn.action !== 'targeted' || !Array.isArray(turn.responses) || turn.responses.length === 0) {
          throw new Error('Telegram turn must use explicitly targeted responses')
        }
        const pending = turn.responses.filter(response => {
          const equivalent = hasEquivalentSentResponse(this.#state, turn, response)
          equivalentSent ||= equivalent
          return !equivalent
        })
        sent = await this.#queueTargetedResponses(update, row.updateId, pending)
      }

      this.#state.completeUpdate({ updateId: row.updateId, workerId: this.#workerId, nowMs: this.#clock() })
      return {
        status: 'completed',
        action: turn.skipped ? 'skipped' : sent > 0 ? 'answered' : equivalentSent ? 'tool_sent' : 'skipped',
      }
    } catch (error) {
      const permanent = error?.turnAccepted === true
        || row.attempts >= 5
        || (error instanceof TelegramApiError && !(error instanceof RateLimitError))
      this.#state.failUpdate({
        updateId: row.updateId,
        workerId: this.#workerId,
        error: error.message,
        retryAtMs: this.#clock() + Math.min(60_000, 1_000 * (2 ** Math.max(0, row.attempts - 1))),
        permanent,
        nowMs: this.#clock(),
      })
      return { status: 'failed', error }
    }
  }

  #startTyping(update) {
    const payload = { chatId: update.chat.id, action: 'typing', threadId: topicId(update) }
    this.#telegram.sendChatAction(payload).catch(() => {})
    const timer = setInterval(() => this.#telegram.sendChatAction(payload).catch(() => {}), this.#typingIntervalMs)
    timer.unref?.()
    return timer
  }

  async #sendSystemReply(update, updateId, text) {
    const group = `system:update:${updateId}`
    this.#state.createOutboundAction({
      actionId: `${group}:0000`,
      conversationKey: update.conversationKey,
      actionType: 'reply',
      payload: {
        chatId: update.chat.id,
        messageId: messageIdForReply(update),
        threadId: topicId(update),
        text,
      },
      sequenceGroup: group,
      sequenceIndex: 0,
      nowMs: this.#clock(),
    })
    await this.#sendOutboundAction(`${group}:0000`)
  }

  async #sendContextBreakNotice(update, updateId, replacedThreadId) {
    const group = `context-break:update:${updateId}`
    this.#state.createOutboundAction({
      actionId: `${group}:0000`,
      conversationKey: this.#ownerUserId,
      actionType: 'send_text',
      payload: {
        chatId: this.#ownerUserId,
        text: `Codex thread ${replacedThreadId ?? '(unknown)'} could not be resumed for ${update.conversationKey}. A new thread was started; prior context was not migrated.`,
      },
      sequenceGroup: group,
      sequenceIndex: 0,
      nowMs: this.#clock(),
    })
    await this.#sendOutboundAction(`${group}:0000`)
  }

  async #queueFinalAnswer(update, updateId, text) {
    const chunks = splitTelegramText(text)
    const group = `answer:update:${updateId}`
    const ids = []
    for (let index = 0; index < chunks.length; index += 1) {
      const actionId = `${group}:${String(index).padStart(4, '0')}`
      const first = index === 0 && messageIdForReply(update)
      this.#state.createOutboundAction({
        actionId,
        conversationKey: update.conversationKey,
        actionType: first ? 'reply' : 'send_text',
        payload: {
          chatId: update.chat.id,
          messageId: first ? messageIdForReply(update) : null,
          threadId: topicId(update),
          text: chunks[index],
        },
        sequenceGroup: group,
        sequenceIndex: index,
        nowMs: this.#clock(),
      })
      ids.push(actionId)
    }
    for (const actionId of ids) {
      const status = await this.#sendOutboundAction(actionId)
      if (status !== 'sent') break
    }
  }

  async #queueReaction(update, updateId, emoji) {
    const messageId = messageIdForReply(update)
    if (!messageId) throw new Error('Telegram reaction requires a message target')
    const actionId = `reaction:update:${updateId}`
    this.#state.createOutboundAction({
      actionId,
      conversationKey: update.conversationKey,
      actionType: 'react',
      payload: {
        chatId: update.chat.id,
        messageId,
        reaction: { type: 'emoji', emoji: emoji.trim() },
        isBig: false,
      },
      sequenceGroup: actionId,
      sequenceIndex: 0,
      nowMs: this.#clock(),
    })
    await this.#sendOutboundAction(actionId)
  }

  async #queueTargetedResponses(update, updateId, responses) {
    let sent = 0
    for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
      const response = responses[responseIndex]
      let action = response.action
      let messageId = response.messageId
      if (typeof response.conversationKey !== 'string' || !response.conversationKey) {
        throw new Error('targeted Telegram response requires conversationKey')
      }
      if (!['send', 'reply', 'react', 'dice'].includes(action)) {
        throw new Error('unsupported targeted Telegram response action')
      }
      if (typeof response.text !== 'string' || !response.text.trim()) {
        throw new Error('targeted Telegram response text is required')
      }
      if (action === 'reply') {
        const expectedMessageId = messageIdForReply(update)
        if (
          response.conversationKey !== update.conversationKey
          || messageId !== expectedMessageId
        ) throw new Error('targeted Telegram response does not match the current update')
        action = 'send'
        messageId = null
      }
      if (action !== 'send') {
        const expectedMessageId = messageIdForReply(update)
        if (
          response.conversationKey !== update.conversationKey
          || messageId !== expectedMessageId
        ) throw new Error('targeted Telegram response does not match the current update')
      }

      if (action === 'react') {
        await this.#queueReaction(update, `${updateId}:target:${responseIndex}`, response.text)
        sent += 1
        continue
      }

      const group = `targeted:update:${updateId}:${String(responseIndex).padStart(2, '0')}`

      if (action === 'dice') {
        const actionId = `${group}:0000`
        this.#state.createOutboundAction({
          actionId,
          conversationKey: response.conversationKey,
          actionType: 'send_dice',
          payload: {
            chatId: update.chat.id,
            threadId: topicId(update),
            replyToMessageId: messageId,
            emoji: response.text.trim(),
          },
          sequenceGroup: group,
          sequenceIndex: 0,
          nowMs: this.#clock(),
        })
        await this.#sendOutboundAction(actionId)
        sent += 1
        continue
      }

      if (action === 'send' && messageId !== null) {
        throw new Error('targeted standalone send requires messageId=null')
      }
      const approved = action === 'send'
        ? this.#state.getApprovedChat(response.conversationKey)
        : null
      if (action === 'send' && !approved) {
        throw new Error('targeted Telegram response is not an approved conversation')
      }
      const chatId = action === 'send' ? approved.telegramChatId : update.chat.id
      const threadId = action === 'send' && approved.kind === 'forum_topic'
        ? response.conversationKey.slice(`${approved.telegramChatId}:`.length)
        : topicId(update)
      const chunks = splitTelegramText(response.text)
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const first = chunkIndex === 0
        const actionId = `${group}:${String(chunkIndex).padStart(4, '0')}`
        this.#state.createOutboundAction({
          actionId,
          conversationKey: response.conversationKey,
          actionType: action === 'reply' && first ? 'reply' : 'send_text',
          payload: {
            chatId,
            messageId: action === 'reply' && first ? messageId : null,
            threadId,
            text: chunks[chunkIndex],
          },
          sequenceGroup: group,
          sequenceIndex: chunkIndex,
          nowMs: this.#clock(),
        })
        const status = await this.#sendOutboundAction(actionId)
        if (status !== 'sent') break
        sent += 1
      }
    }
    return sent
  }

  async #executeOutbound(action) {
    if (action.actionType === 'reply') return this.#telegram.reply(action.payload)
    if (action.actionType === 'send_text') return this.#telegram.sendText(action.payload)
    if (action.actionType === 'edit_own_message') return this.#telegram.editOwnMessage(action.payload)
    if (action.actionType === 'delete_own_message') return this.#telegram.deleteOwnMessage(action.payload)
    if (action.actionType === 'react') return this.#telegram.react(action.payload)
    if (action.actionType === 'send_dice') return this.#telegram.sendDice(action.payload)
    if (action.actionType === 'send_file') {
      return this.#telegram.sendFile({
        ...action.payload,
        bytes: await readFile(action.payload.path),
      })
    }
    throw new Error(`unsupported outbound action type: ${action.actionType}`)
  }

  async enqueueExternalAction({ actionId, conversationKey, actionType, payload }) {
    this.#state.createOutboundAction({
      actionId,
      conversationKey,
      actionType,
      payload,
      sequenceGroup: actionId,
      sequenceIndex: 0,
      nowMs: this.#clock(),
    })
    await this.#sendOutboundAction(actionId)
    return this.#state.getOutboundAction(actionId)
  }

  async #sendOutboundAction(actionId, alreadyClaimed = false) {
    let action = this.#state.getOutboundAction(actionId)
    if (!action) throw new Error(`outbound action not found: ${actionId}`)
    if (['sent', 'ambiguous'].includes(action.status)) return action.status
    if (!alreadyClaimed && !this.#state.markOutboundSending(actionId, this.#clock())) {
      return this.#state.getOutboundAction(actionId).status
    }
    action = this.#state.getOutboundAction(actionId)
    try {
      const result = await this.#executeOutbound(action)
      this.#state.markOutboundSent(actionId, {
        telegramChatId: String(result?.chat?.id ?? action.payload.chatId),
        telegramMessageId: result?.message_id === undefined ? null : String(result.message_id),
        result,
        botIdentity: this.#botIdentity,
      }, this.#clock())
      return 'sent'
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.#state.markOutboundFailed(
          actionId,
          error.message,
          this.#clock() + error.retryAfterSec * 1_000,
          this.#clock(),
        )
        return 'failed'
      }
      if (error instanceof TelegramTransportError && error.deliveryAmbiguous) {
        this.#state.markOutboundAmbiguous(actionId, error.message, this.#clock())
        return 'ambiguous'
      }
      const retryAtMs = error instanceof TelegramTransportError ? this.#clock() + 1_000 : null
      this.#state.markOutboundFailed(actionId, error.message, retryAtMs, this.#clock())
      return 'failed'
    }
  }

  async drainOutboundOnce({ limit = 16 } = {}) {
    const actions = this.#state.claimDueOutboundActions({
      workerId: this.#workerId,
      limit,
      nowMs: this.#clock(),
    })
    for (const action of actions) await this.#sendOutboundAction(action.actionId, true)
    return actions.length
  }

  async drainWakesOnce({ limit = 8 } = {}) {
    const wakes = this.#state.claimWakes({
      workerId: this.#workerId,
      limit,
      leaseMs: this.#updateLeaseMs,
      nowMs: this.#clock(),
    })
    const results = await Promise.all(wakes.map(wake => this.#schedule(
      wake.conversationKey,
      () => this.#processWake(wake),
    )))
    return {
      claimed: wakes.length,
      processed: results.filter(result => result.status === 'completed').length,
      failed: results.filter(result => result.status === 'failed').length,
    }
  }

  async #processWake(wake) {
    try {
      const chat = this.#state.getApprovedChat(wake.conversationKey)
      if (!chat) throw new Error(`wake target is no longer approved: ${wake.conversationKey}`)
      const syntheticUpdate = {
        conversationKey: wake.conversationKey,
        chat: { id: chat.telegramChatId, type: chat.kind, title: chat.title },
        actor: null,
        message: null,
        reaction: null,
      }
      const typing = this.#startTyping(syntheticUpdate)
      let turn
      try {
        turn = await this.#runner.runTurn({
          conversationKey: wake.conversationKey,
          ownerDm: chat.kind === 'private' && chat.telegramChatId === this.#ownerUserId,
          text: [
            '[Proactive wake request]',
            `Source: ${wake.source}`,
            `Reason: ${wake.reason}`,
            wake.context === null ? null : `Context: ${JSON.stringify(wake.context)}`,
          ].filter(Boolean).join('\n'),
          attachments: [],
          telegramContext: {
            eventType: 'wake',
            wakeId: wake.id,
            source: wake.source,
            conversationKey: wake.conversationKey,
          },
          clientUserMessageId: `wake:${wake.id}`,
        })
      } finally {
        clearInterval(typing)
      }
      if (turn.contextBreak) {
        await this.#sendContextBreakNotice(syntheticUpdate, `wake-${wake.id}`, turn.replacedThreadId)
      }
      if (!turn.skipped) {
        if (turn.action !== 'targeted' || !Array.isArray(turn.responses) || turn.responses.length === 0) {
          throw new Error('Telegram turn must use explicitly targeted responses')
        }
        const pending = turn.responses.filter(
          response => !hasEquivalentSentResponse(this.#state, turn, response),
        )
        await this.#queueTargetedResponses(syntheticUpdate, `wake-${wake.id}`, pending)
      }
      this.#state.completeWake({ id: wake.id, workerId: this.#workerId, nowMs: this.#clock() })
      return { status: 'completed' }
    } catch (error) {
      this.#state.failWake({
        id: wake.id,
        workerId: this.#workerId,
        error: error.message,
        retryAtMs: this.#clock() + Math.min(60_000, 1_000 * (2 ** Math.max(0, wake.attempts - 1))),
        permanent: error?.turnAccepted === true || wake.attempts >= 5,
        nowMs: this.#clock(),
      })
      return { status: 'failed', error }
    }
  }
}
