import { JsonLineSocketServer } from './json-line-socket.mjs'

export class WakeServer {
  #state
  #allowedSources
  #clock
  #server

  constructor({ socketPath, stateStore, allowedSources, clock = Date.now }) {
    this.#state = stateStore
    this.#allowedSources = allowedSources
    this.#clock = clock
    this.#server = new JsonLineSocketServer({ socketPath, handler: request => this.#handle(request) })
  }

  start() {
    return this.#server.start()
  }

  close() {
    return this.#server.close()
  }

  #resolveTarget(target) {
    const chat = this.#state.getApprovedChatByAlias(target) ?? this.#state.getApprovedChat(target)
    if (!chat) throw new Error('unknown or unapproved Telegram target')
    return chat
  }

  #handle(request) {
    if (request.action !== 'enqueue_wake') throw new Error('unsupported wake action')
    const params = request.params ?? {}
    if (!this.#allowedSources.has(params.source)) throw new Error('wake source is not allowed')
    if (typeof params.reason !== 'string' || params.reason.length === 0 || params.reason.length > 2000) {
      throw new Error('wake reason must be a non-empty string up to 2000 characters')
    }
    if (typeof params.dedupeKey !== 'string' || params.dedupeKey.length === 0 || params.dedupeKey.length > 256) {
      throw new Error('wake dedupeKey must be a non-empty string up to 256 characters')
    }
    const chat = this.#resolveTarget(params.target)
    const nowMs = this.#clock()
    const earliestAtMs = params.earliestAtMs ?? nowMs
    const expiresAtMs = params.expiresAtMs
    if (!Number.isSafeInteger(earliestAtMs) || !Number.isSafeInteger(expiresAtMs)) {
      throw new Error('wake times must be integer milliseconds')
    }
    const result = this.#state.enqueueWake({
      conversationKey: chat.conversationKey,
      source: params.source,
      reason: params.reason,
      context: params.context ?? null,
      dedupeKey: params.dedupeKey,
      earliestAtMs,
      expiresAtMs,
      nowMs,
    })
    return { created: result.created, wakeId: result.wake.id, status: result.wake.status }
  }
}
