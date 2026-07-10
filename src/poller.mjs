import { normalizeUpdate } from './update-normalizer.mjs'
import { DuplicatePollerError, RateLimitError, TelegramTransportError } from './telegram-client.mjs'

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export class Poller {
  #telegram
  #state
  #pollTimeoutSec
  #normalizer
  #sleep
  #jitter
  #onBatchStored

  constructor({
    telegramClient,
    stateStore,
    pollTimeoutSec = 50,
    normalizer = normalizeUpdate,
    sleep = defaultSleep,
    jitter = () => Math.floor(Math.random() * 500),
    onBatchStored = null,
  }) {
    this.#telegram = telegramClient
    this.#state = stateStore
    this.#pollTimeoutSec = pollTimeoutSec
    this.#normalizer = normalizer
    this.#sleep = sleep
    this.#jitter = jitter
    this.#onBatchStored = onBatchStored
  }

  async pollOnce({ signal } = {}) {
    const updates = await this.#telegram.getUpdates({
      offset: this.#state.getPollOffset(),
      timeoutSec: this.#pollTimeoutSec,
      signal,
    })
    let inserted = 0
    for (const raw of updates) {
      let normalized
      try {
        normalized = this.#normalizer(raw)
      } catch (error) {
        if (raw?.update_id === undefined) throw error
        normalized = { type: 'normalization_error', conversationKey: null }
      }
      const stored = this.#state.storeUpdate({
        updateId: String(raw.update_id),
        raw,
        normalizedType: normalized.type,
        conversationKey: normalized.conversationKey,
      })
      if (stored.inserted) inserted += 1
    }
    const result = { received: updates.length, inserted, pollOffset: this.#state.getPollOffset() }
    if (inserted > 0) await this.#onBatchStored?.(result)
    return result
  }

  async run({ signal } = {}) {
    let transportFailures = 0
    while (!signal?.aborted) {
      try {
        await this.pollOnce({ signal })
        transportFailures = 0
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') break
        if (error instanceof DuplicatePollerError) throw error
        if (error instanceof RateLimitError) {
          await this.#sleep(error.retryAfterSec * 1_000 + this.#jitter(), signal)
          continue
        }
        if (error instanceof TelegramTransportError) {
          transportFailures += 1
          const backoff = Math.min(30_000, 1_000 * (2 ** (transportFailures - 1)))
          await this.#sleep(backoff + this.#jitter(), signal)
          continue
        }
        throw error
      }
    }
  }
}
