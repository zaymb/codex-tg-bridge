import { AppServerRpcError } from './app-server-client.mjs'

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'text', 'reason'],
  properties: {
    action: { type: 'string', enum: ['send', 'skip'] },
    text: { type: 'string' },
    reason: { type: 'string' },
  },
})

const OUTPUT_INSTRUCTIONS = [
  'Return only the structured result required by outputSchema.',
  'Use action=send and put the complete Telegram-ready final answer in text.',
  'Use action=skip only when no Telegram response should be sent, with a concise reason.',
  'Do not expose reasoning, tool progress, or partial output.',
].join(' ')

export class CodexTurnTimeoutError extends Error {
  constructor(threadId, turnId, timeoutMs) {
    super(`Codex turn ${turnId} timed out after ${timeoutMs}ms`)
    this.name = 'CodexTurnTimeoutError'
    this.threadId = threadId
    this.turnId = turnId
    this.timeoutMs = timeoutMs
  }
}

export class CodexTurnFailedError extends Error {
  constructor(threadId, turnId, message, status = 'failed') {
    super(`Codex turn ${turnId} ${status}: ${message}`)
    this.name = 'CodexTurnFailedError'
    this.threadId = threadId
    this.turnId = turnId
    this.status = status
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
}

function isStaleThreadError(error) {
  return error instanceof AppServerRpcError
    && /thread.{0,40}(missing|not found|does not exist|corrupt|failed to load)|rollout.{0,30}(missing|not found|corrupt)/iu.test(error.message)
}

function buildInput(text, attachments) {
  const images = []
  const referencedFiles = []
  for (const item of attachments ?? []) {
    if (item.kind === 'photo') images.push({ type: 'localImage', path: item.localPath })
    else referencedFiles.push(`- ${item.fileName || item.kind}: ${item.localPath}`)
  }
  const suffix = referencedFiles.length > 0
    ? `\n\nTelegram attachments:\n${referencedFiles.join('\n')}`
    : ''
  const messageText = `${text ?? ''}${suffix}`.trim()
  const input = []
  if (messageText) input.push({ type: 'text', text: messageText })
  input.push(...images)
  if (input.length === 0) input.push({ type: 'text', text: '[Telegram event with no text content]' })
  return input
}

function findActionIds(value, output = new Set()) {
  if (!value || typeof value !== 'object') return output
  if (typeof value.actionId === 'string') output.add(value.actionId)
  if (Array.isArray(value)) {
    for (const item of value) findActionIds(item, output)
  } else {
    for (const item of Object.values(value)) findActionIds(item, output)
  }
  return output
}

function extractTurnItems(turn, collected) {
  if (Array.isArray(turn?.items) && turn.items.length > 0) return turn.items
  return collected
}

function extractFinal(items) {
  const agentMessages = items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
  const finalMessages = agentMessages.filter(item => item.phase === 'final_answer')
  const authoritative = (finalMessages.length > 0 ? finalMessages : agentMessages).at(-1)
  return authoritative?.text ?? ''
}

function parseStructuredOutput(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed?.action === 'skip') {
      return { skipped: true, finalText: null, reason: String(parsed.reason ?? '') }
    }
    if (parsed?.action === 'send' && typeof parsed.text === 'string') {
      return { skipped: false, finalText: parsed.text, reason: String(parsed.reason ?? '') }
    }
  } catch {}
  const skip = text.match(/^\s*\[SKIP\](?:\s+理由[:：]?)?\s*(.*)$/isu)
  if (skip) return { skipped: true, finalText: null, reason: skip[1].trim() }
  return { skipped: false, finalText: text, reason: 'unstructured_compatibility_output' }
}

class TurnCollector {
  #client
  #threadId
  #items = new Map()
  #completions = new Map()
  #waiters = new Map()
  #onItem
  #onTurn

  constructor(client, threadId) {
    this.#client = client
    this.#threadId = threadId
    this.#onItem = params => {
      if (params.threadId !== this.#threadId || !params.turnId) return
      const items = this.#items.get(params.turnId) ?? []
      items.push(params.item)
      this.#items.set(params.turnId, items)
    }
    this.#onTurn = params => {
      if (params.threadId !== this.#threadId || !params.turn?.id) return
      const turnId = params.turn.id
      const value = { turn: params.turn, collectedItems: this.#items.get(turnId) ?? [] }
      const waiter = this.#waiters.get(turnId)
      if (waiter) {
        this.#waiters.delete(turnId)
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      } else {
        this.#completions.set(turnId, value)
      }
    }
    client.on('notification:item/completed', this.#onItem)
    client.on('notification:turn/completed', this.#onTurn)
  }

  wait(turnId, timeoutMs, onTimeout) {
    if (this.#completions.has(turnId)) {
      const value = this.#completions.get(turnId)
      this.#completions.delete(turnId)
      return Promise.resolve(value)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.#waiters.delete(turnId)
        try {
          await onTimeout()
        } catch {}
        reject(new CodexTurnTimeoutError(this.#threadId, turnId, timeoutMs))
      }, timeoutMs)
      timer.unref?.()
      this.#waiters.set(turnId, { resolve, reject, timer })
    })
  }

  dispose(error = new Error('turn collector disposed')) {
    this.#client.off('notification:item/completed', this.#onItem)
    this.#client.off('notification:turn/completed', this.#onTurn)
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#waiters.clear()
  }
}

export class CodexRunner {
  #client
  #state
  #config

  constructor({ client, stateStore, config }) {
    this.#client = client
    this.#state = stateStore
    this.#config = config
  }

  #threadOverrides(ownerDm, conversation) {
    return compact({
      model: conversation?.modelOverride ?? this.#config.model,
      cwd: this.#config.codexWorkdir,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: ownerDm ? 'workspace-write' : 'read-only',
      runtimeWorkspaceRoots: ownerDm ? this.#config.codexWritableRoots : [],
    })
  }

  async #getOrCreateThread(conversationKey, ownerDm) {
    let conversation = this.#state.getConversation(conversationKey)
    let contextBreak = false
    let replacedThreadId = null

    if (conversation?.threadId) {
      try {
        const resumed = await this.#client.request('thread/resume', {
          threadId: conversation.threadId,
          ...this.#threadOverrides(ownerDm, conversation),
        })
        return { threadId: resumed.thread.id, contextBreak, replacedThreadId, conversation }
      } catch (error) {
        if (!isStaleThreadError(error)) throw error
        replacedThreadId = this.#state.detachThread(conversationKey, error.message)
        contextBreak = true
        conversation = this.#state.getConversation(conversationKey)
      }
    }

    const started = await this.#client.request('thread/start', {
      ...this.#threadOverrides(ownerDm, conversation),
      serviceName: 'tg_engage_bridge',
    })
    const threadId = started.thread.id
    conversation = this.#state.upsertConversation({ conversationKey, threadId })
    return { threadId, contextBreak, replacedThreadId, conversation }
  }

  async runTurn({
    conversationKey,
    ownerDm,
    text,
    attachments = [],
    telegramContext = {},
    clientUserMessageId = null,
  }) {
    const thread = await this.#getOrCreateThread(conversationKey, ownerDm)
    const collector = new TurnCollector(this.#client, thread.threadId)
    let turnId = null
    try {
      const turnResponse = await this.#client.request('turn/start', compact({
        threadId: thread.threadId,
        input: buildInput(text, attachments),
        clientUserMessageId,
        model: thread.conversation?.modelOverride ?? this.#config.model,
        effort: thread.conversation?.effortOverride ?? this.#config.effort,
        cwd: this.#config.codexWorkdir,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        runtimeWorkspaceRoots: ownerDm ? this.#config.codexWritableRoots : [],
        sandboxPolicy: ownerDm
          ? {
              type: 'workspaceWrite',
              writableRoots: this.#config.codexWritableRoots,
              networkAccess: false,
            }
          : { type: 'readOnly', networkAccess: false },
        additionalContext: {
          telegram: { kind: 'untrusted', value: JSON.stringify(telegramContext) },
          telegram_output_contract: { kind: 'application', value: OUTPUT_INSTRUCTIONS },
        },
        outputSchema: OUTPUT_SCHEMA,
      }))
      turnId = turnResponse.turn.id
      this.#state.setActiveTurn({ conversationKey, turnId })

      const completion = await collector.wait(
        turnId,
        this.#config.turnTimeoutMs,
        () => this.#client.request('turn/interrupt', { threadId: thread.threadId, turnId }),
      )
      const items = extractTurnItems(completion.turn, completion.collectedItems)
      if (completion.turn.status !== 'completed') {
        const message = completion.turn.error?.message ?? 'turn did not complete successfully'
        throw new CodexTurnFailedError(thread.threadId, turnId, message, completion.turn.status)
      }
      const output = parseStructuredOutput(extractFinal(items))
      const actionIds = [...findActionIds(items.filter(item => item?.type === 'mcpToolCall' && item.server === 'telegram'))]
      return {
        threadId: thread.threadId,
        turnId,
        finalText: output.finalText,
        skipped: output.skipped,
        reason: output.reason,
        sentActionIds: actionIds,
        contextBreak: thread.contextBreak,
        replacedThreadId: thread.replacedThreadId,
      }
    } finally {
      if (turnId) this.#state.clearActiveTurn({ conversationKey, turnId })
      collector.dispose()
    }
  }

  async interrupt(conversationKey) {
    const conversation = this.#state.getConversation(conversationKey)
    if (!conversation?.threadId || !conversation.activeTurnId) return false
    await this.#client.request('turn/interrupt', {
      threadId: conversation.threadId,
      turnId: conversation.activeTurnId,
    })
    this.#state.clearActiveTurn({ conversationKey, turnId: conversation.activeTurnId })
    return true
  }
}
