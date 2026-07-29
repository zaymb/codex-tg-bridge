export class TypingPulse {
  #state
  #telegram
  #sessionLabel
  #intervalMs
  #clock
  #lastAttemptAt = new Map()

  constructor({
    stateStore,
    telegramClient,
    sessionLabel,
    intervalMs = 4_000,
    clock = Date.now,
  }) {
    if (!sessionLabel) throw new Error('typing pulse sessionLabel is required')
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('typing pulse intervalMs must be a positive integer')
    }
    this.#state = stateStore
    this.#telegram = telegramClient
    this.#sessionLabel = String(sessionLabel)
    this.#intervalMs = intervalMs
    this.#clock = clock
  }

  async drainOnce() {
    const nowMs = this.#clock()
    const targets = this.#state.listAcceptedRelayTypingTargets(this.#sessionLabel, nowMs)
    const activeKeys = new Set(targets.map(target => this.#key(target)))
    for (const key of this.#lastAttemptAt.keys()) {
      if (!activeKeys.has(key)) this.#lastAttemptAt.delete(key)
    }

    const due = targets.filter(target => {
      const lastAttemptAt = this.#lastAttemptAt.get(this.#key(target))
      return lastAttemptAt === undefined || nowMs - lastAttemptAt >= this.#intervalMs
    })
    for (const target of due) this.#lastAttemptAt.set(this.#key(target), nowMs)
    await Promise.allSettled(due.map(target => this.#telegram.sendChatAction({
      chatId: target.chatId,
      action: 'typing',
      threadId: target.threadId,
    })))
    return due.length
  }

  #key(target) {
    return `${target.conversationKey}\0${target.turnId}`
  }
}
