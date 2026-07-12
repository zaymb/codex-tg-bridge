function aliasByTarget(config) {
  const result = new Map()
  for (const [alias, target] of config.chatAliases) {
    if (result.has(target)) throw new Error(`multiple aliases target the same Telegram conversation: ${target}`)
    result.set(target, alias)
  }
  return result
}

export function seedApprovedChats(stateStore, config, nowMs = Date.now()) {
  const aliases = aliasByTarget(config)
  const chats = [{
    conversationKey: config.ownerUserId,
    telegramChatId: config.ownerUserId,
    alias: 'owner',
    title: 'Owner DM',
    kind: 'private',
  }]
  for (const chatId of config.allowedChatIds) {
    chats.push({
      conversationKey: chatId,
      telegramChatId: chatId,
      alias: aliases.get(chatId) ?? null,
      title: null,
      kind: 'group',
    })
  }
  for (const channelId of config.allowedChannelIds) {
    chats.push({
      conversationKey: channelId,
      telegramChatId: channelId,
      alias: aliases.get(channelId) ?? null,
      title: null,
      kind: 'channel',
    })
  }
  for (const [alias, target] of config.chatAliases) {
    if (!target.includes(':')) continue
    const [chatId] = target.split(':')
    chats.push({
      conversationKey: target,
      telegramChatId: chatId,
      alias,
      title: null,
      kind: 'forum_topic',
    })
  }
  stateStore.replaceApprovedChats(chats, nowMs)
}

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

export async function createBridgeRuntime({
  config,
  contract = null,
  fetchImpl = globalThis.fetch,
  workerIdleMs = 100,
}) {
  const stateStore = StateStore.open(config.dbPath)
  let appServerClient = null
  let actionServer = null
  let wakeServer = null
  let approvalRouter = null
  let started = false
  let closed = false
  try {
    seedApprovedChats(stateStore, config)
    stateStore.recoverInterruptedOutboundActions()
    stateStore.expirePendingApprovals()
    const attachmentStore = await AttachmentStore.open({
      root: config.attachmentRoot,
      exportRoots: config.exportRoots,
    })
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

    const protocolContract = contract ?? JSON.parse(await readFile(config.codexContractPath, 'utf8'))
    appServerClient = await AppServerClient.connect({
      socketPath: config.appServerSocket,
      contract: protocolContract,
      requestTimeoutMs: Math.min(config.turnTimeoutMs, 30_000),
    })
    const runner = new CodexRunner({ client: appServerClient, stateStore, config })
    await runner.recoverInterruptedTurns()
    approvalRouter = new ApprovalRouter({
      appServerClient,
      stateStore,
      telegramClient,
      ownerUserId: config.ownerUserId,
    })
    const engagementPolicy = new EngagementPolicy(config, {
      botUserId: String(bot.id),
      botUsername: bot.username,
    })
    const dispatcher = new Dispatcher({
      stateStore,
      telegramClient,
      codexRunner: runner,
      approvalRouter,
      engagementPolicy,
      attachmentStore,
      ownerUserId: config.ownerUserId,
      maxConcurrentTurns: config.maxConcurrentTurns,
      updateLeaseMs: config.updateLeaseMs,
      typingIntervalMs: config.typingIntervalMs,
      botIdentity: bot,
    })
    const poller = new Poller({
      telegramClient,
      stateStore,
      pollTimeoutSec: config.pollTimeoutSec,
    })
    actionServer = new ControlServer({
      socketPath: config.actionSocket,
      stateStore,
      dispatcher,
      attachmentStore,
      ownerUserId: config.ownerUserId,
      privateChatIds: config.privateChatIds,
    })
    wakeServer = new WakeServer({
      socketPath: config.wakeSocket,
      stateStore,
      allowedSources: new Set(['cron', 'sw', 'manual']),
    })

    const runtime = {
      stateStore,
      telegramClient,
      appServerClient,
      runner,
      approvalRouter,
      dispatcher,
      poller,
      bot,
      async start() {
        if (started) return
        await actionServer.start()
        try {
          await wakeServer.start()
        } catch (error) {
          await actionServer.close()
          throw error
        }
        approvalRouter.start()
        started = true
      },
      async run({ signal } = {}) {
        await runtime.start()
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener('abort', abort, { once: true })
        const worker = async () => {
          while (!controller.signal.aborted) {
            const inbound = await dispatcher.drainOnce()
            const outbound = await dispatcher.drainOutboundOnce()
            const wakes = await dispatcher.drainWakesOnce()
            if (inbound.claimed === 0 && outbound === 0 && wakes.claimed === 0) {
              await idle(workerIdleMs, controller.signal)
            }
          }
        }
        const controlWorker = async () => {
          while (!controller.signal.aborted) {
            const controls = await dispatcher.drainControlsOnce()
            if (controls.claimed === 0) await idle(Math.min(workerIdleMs, 50), controller.signal)
          }
        }
        const poll = poller.run({ signal: controller.signal })
        const work = worker()
        const controls = controlWorker()
        let removeFailureListeners = () => {}
        const appServerFailure = new Promise((resolve, reject) => {
          const failed = error => reject(error)
          appServerClient.once('close', failed)
          appServerClient.once('protocolError', failed)
          removeFailureListeners = () => {
            appServerClient.off('close', failed)
            appServerClient.off('protocolError', failed)
          }
        })
        try {
          await Promise.race([poll, work, controls, appServerFailure])
        } finally {
          signal?.removeEventListener('abort', abort)
          removeFailureListeners()
          controller.abort()
          await Promise.allSettled([poll, work, controls])
          await runtime.close()
        }
      },
      async close() {
        if (closed) return
        closed = true
        approvalRouter.stop()
        await Promise.allSettled([
          actionServer.close(),
          wakeServer.close(),
          appServerClient.close(),
        ])
        stateStore.close()
      },
    }
    return runtime
  } catch (error) {
    approvalRouter?.stop()
    await Promise.allSettled([
      actionServer?.close(),
      wakeServer?.close(),
      appServerClient?.close(),
    ])
    stateStore.close()
    throw error
  }
}
import { readFile } from 'node:fs/promises'

import { AppServerClient } from './app-server-client.mjs'
import { ApprovalRouter } from './approval-router.mjs'
import { AttachmentStore } from './attachment-store.mjs'
import { ControlServer } from './control-server.mjs'
import { CodexRunner } from './codex-runner.mjs'
import { Dispatcher } from './dispatcher.mjs'
import { EngagementPolicy } from './engagement-policy.mjs'
import { Poller } from './poller.mjs'
import { StateStore } from './state-store.mjs'
import { TelegramClient } from './telegram-client.mjs'
import { WakeServer } from './wake-server.mjs'
