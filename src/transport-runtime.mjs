import { EngagementPolicy } from './engagement-policy.mjs'
import { OutboundDrain } from './outbound-drain.mjs'
import { Poller } from './poller.mjs'
import { RelayDispatcher } from './relay-dispatcher.mjs'
import { seedApprovedChats } from './runtime.mjs'
import { StateStore } from './state-store.mjs'
import { TelegramClient } from './telegram-client.mjs'

function idle(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export async function createTransportRuntime({
  config,
  fetchImpl = globalThis.fetch,
  workerIdleMs = 100,
} = {}) {
  const stateStore = StateStore.open(config.dbPath)
  let closed = false
  try {
    seedApprovedChats(stateStore, config)
    stateStore.ensureRelaySession(config.sessionLabel)
    stateStore.expireRelayJobs()
    stateStore.recoverInterruptedOutboundActions()

    const telegramClient = new TelegramClient({
      tokenReader: config.readTelegramToken,
      fetchImpl,
    })
    const [bot, webhook] = await Promise.all([
      telegramClient.getMe(),
      telegramClient.getWebhookInfo(),
    ])
    if (webhook?.url) {
      throw new Error('Telegram bot still has a webhook configured; long polling will not start')
    }

    const groupGate = config.deliverAllGroupMessages
      ? { evaluate: () => ({ deliver: true, reason: 'configured_group_passthrough' }) }
      : null
    const engagementPolicy = new EngagementPolicy(config, {
      botUserId: String(bot.id),
      botUsername: bot.username,
      groupGate,
    })
    const dispatcher = new RelayDispatcher({
      stateStore,
      engagementPolicy,
      sessionLabel: config.sessionLabel,
      updateLeaseMs: config.updateLeaseMs,
    })
    const outbound = new OutboundDrain({ stateStore, telegramClient })
    const poller = new Poller({
      telegramClient,
      stateStore,
      pollTimeoutSec: config.pollTimeoutSec,
    })

    const runtime = {
      stateStore,
      telegramClient,
      dispatcher,
      outbound,
      poller,
      bot,
      async run({ signal } = {}) {
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener('abort', abort, { once: true })
        const worker = async () => {
          while (!controller.signal.aborted) {
            const inbound = await dispatcher.drainOnce()
            const sent = await outbound.drainOnce()
            stateStore.expireRelayJobs()
            if (inbound.claimed === 0 && sent === 0) await idle(workerIdleMs, controller.signal)
          }
        }
        const poll = poller.run({ signal: controller.signal })
        const work = worker()
        try {
          await Promise.race([poll, work])
        } finally {
          signal?.removeEventListener('abort', abort)
          controller.abort()
          await Promise.allSettled([poll, work])
          await runtime.close()
        }
      },
      close() {
        if (closed) return
        closed = true
        stateStore.close()
      },
    }
    return runtime
  } catch (error) {
    stateStore.close()
    throw error
  }
}
