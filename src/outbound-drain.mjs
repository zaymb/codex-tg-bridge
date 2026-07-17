import { readFile } from 'node:fs/promises'

import {
  RateLimitError,
  TelegramTransportError,
} from './telegram-client.mjs'

export class OutboundDrain {
  #state
  #telegram
  #workerId
  #clock
  #botIdentity
  #control

  constructor({
    stateStore,
    telegramClient,
    workerId = `outbound-${process.pid}`,
    clock = Date.now,
    botIdentity = null,
    transportControl = null,
  }) {
    this.#state = stateStore
    this.#telegram = telegramClient
    this.#workerId = workerId
    this.#clock = clock
    this.#botIdentity = botIdentity
    this.#control = transportControl
  }

  async #execute(action) {
    if (action.actionType === 'reply') return this.#telegram.reply(action.payload)
    if (action.actionType === 'send_text') return this.#telegram.sendText(action.payload)
    if (action.actionType === 'send_dice') return this.#telegram.sendDice(action.payload)
    if (action.actionType === 'edit_own_message') return this.#telegram.editOwnMessage(action.payload)
    if (action.actionType === 'delete_own_message') return this.#telegram.deleteOwnMessage(action.payload)
    if (action.actionType === 'react') return this.#telegram.react(action.payload)
    if (action.actionType === 'answer_callback_query') return this.#telegram.answerCallbackQuery(action.payload)
    if (action.actionType === 'send_file') {
      return this.#telegram.sendFile({
        ...action.payload,
        bytes: await readFile(action.payload.path),
      })
    }
    throw new Error(`unsupported outbound action type: ${action.actionType}`)
  }

  async send(actionId, alreadyClaimed = false) {
    let action = this.#state.getOutboundAction(actionId)
    if (!action) throw new Error(`outbound action not found: ${actionId}`)
    if (['sent', 'ambiguous'].includes(action.status)) return action.status
    if (!alreadyClaimed && !this.#state.markOutboundSending(actionId, this.#clock())) {
      return this.#state.getOutboundAction(actionId).status
    }
    action = this.#state.getOutboundAction(actionId)
    const bestEffort = action.payload?.deliveryClass === 'progress'
    try {
      const result = await this.#execute(action)
      this.#state.markOutboundSent(actionId, {
        telegramChatId: String(result?.chat?.id ?? action.payload.chatId),
        telegramMessageId: result?.message_id === undefined ? null : String(result.message_id),
        result,
        botIdentity: this.#botIdentity,
      }, this.#clock())
      this.#control?.handleAckSent(actionId, this.#clock())
      return 'sent'
    } catch (error) {
      if (error instanceof RateLimitError) {
        const retryAtMs = bestEffort ? null : this.#clock() + error.retryAfterSec * 1_000
        this.#state.markOutboundFailed(actionId, error.message, retryAtMs, this.#clock())
        if (retryAtMs === null) this.#control?.handleAckTerminal(actionId, 'failed', this.#clock())
        return 'failed'
      }
      if (error instanceof TelegramTransportError && error.deliveryAmbiguous) {
        this.#state.markOutboundAmbiguous(actionId, error.message, this.#clock())
        this.#control?.handleAckTerminal(actionId, 'ambiguous', this.#clock())
        return 'ambiguous'
      }
      const retryAtMs = error instanceof TelegramTransportError && !bestEffort
        ? this.#clock() + 1_000
        : null
      this.#state.markOutboundFailed(actionId, error.message, retryAtMs, this.#clock())
      if (retryAtMs === null) this.#control?.handleAckTerminal(actionId, 'failed', this.#clock())
      return 'failed'
    }
  }

  async drainOnce({ limit = 16 } = {}) {
    const actions = this.#state.claimDueOutboundActions({
      workerId: this.#workerId,
      limit,
      nowMs: this.#clock(),
    })
    for (const action of actions) await this.send(action.actionId, true)
    return actions.length
  }
}
