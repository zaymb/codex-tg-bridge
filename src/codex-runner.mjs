import { AppServerRpcError } from './app-server-client.mjs'
import {
  TELEGRAM_TRUST,
  TELEGRAM_TRUST_POLICIES,
  classifyTelegramContext,
  externalFeedTag,
  guardTelegramOutput,
  isInstructionTrust,
} from './channel-trust.mjs'

export const TELEGRAM_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'text', 'reason'],
  properties: {
    action: { type: 'string', enum: ['send', 'react', 'skip'] },
    text: { type: 'string' },
    reason: { type: 'string' },
  },
})

export const TELEGRAM_BATCH_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'text', 'responses', 'reason'],
  properties: {
    action: { type: 'string', enum: ['send', 'react', 'skip'] },
    text: { type: 'string' },
    responses: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['messageId', 'action', 'text', 'isBig'],
        properties: {
          messageId: { type: 'string', pattern: '^\\d+$' },
          action: { type: 'string', enum: ['send', 'react', 'dice'] },
          text: { type: 'string', minLength: 1 },
          isBig: { type: 'boolean' },
        },
      },
    },
    reason: { type: 'string' },
  },
})

export const TELEGRAM_OUTPUT_INSTRUCTIONS = [
  'Return only the structured result required by outputSchema.',
  'Use action=send and put the complete Telegram-ready final answer in text.',
  'Use action=react and put exactly one Telegram reaction emoji in text when a reaction is better than a written reply.',
  'Use action=skip only when no Telegram response should be sent, with a concise reason.',
  'Do not expose reasoning, tool progress, or partial output.',
].join(' ')

export const TELEGRAM_BATCH_OUTPUT_INSTRUCTIONS = [
  'Apply this Telegram output contract only while the latest user input is marked [TG].',
  'Plain-text commentary is delivered immediately to Telegram as a progress update; keep it concise and user-facing, and never wrap commentary in JSON.',
  'Only final_answer may contain the Telegram JSON envelope.',
  'For [TG] input, return one JSON object with exactly action, text, responses, and reason.',
  'Use action=send and put one Telegram-ready answer in text.',
  'Use action=react and put exactly one Telegram reaction emoji in text when a reaction to the latest message is better than a written reply.',
  'Choose exactly one reply form: either put one answer in text and keep responses empty, or set text to an empty string and use responses for selective replies. Never duplicate an answer into both fields.',
  'Each selective response must contain messageId (the listed Telegram message_id rendered as a string), action (send, react, or dice), text, and isBig (a boolean). Omitted messages receive nothing.',
  'Use a targeted response with action=dice and text set to exactly one of 🎲 🎯 🏀 ⚽ 🎳 🎰 to send Telegram animated dice.',
  'Always include responses; use an empty array when no targeted responses are needed.',
  'Use action=skip only when no Telegram response should be sent, with a concise reason.',
  'If a later user input is unmarked, it came from the terminal: answer it normally in plain text without the Telegram JSON envelope.',
  'Do not expose hidden reasoning or raw tool output. Use commentary only for brief progress and final_answer for the final response.',
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

export function parseTelegramStructuredOutput(text) {
  const malformed = () => ({
    action: 'skip',
    skipped: true,
    finalText: null,
    responses: [],
    reason: 'malformed_structured_output',
  })

  const normalizeResponses = value => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null
    const seen = new Set()
    const responses = []
    for (const response of value) {
      const rawMessageId = response?.messageId ?? response?.message_id
      const messageId = typeof rawMessageId === 'number'
        ? String(rawMessageId)
        : rawMessageId
      const action = response?.action === 'send' || response?.action === undefined
        ? 'reply'
        : response?.action
      if (
        typeof messageId !== 'string'
        || !/^\d+$/u.test(messageId)
        || seen.has(messageId)
        || !['reply', 'react', 'dice'].includes(action)
        || typeof response?.text !== 'string'
        || !response.text.trim()
      ) return null
      seen.add(messageId)
      responses.push({
        messageId,
        action,
        text: response.text,
        ...(typeof response.isBig === 'boolean' ? { isBig: response.isBig } : {}),
      })
    }
    return responses
  }

  const parseEnvelope = value => {
    const parsed = JSON.parse(value)
    if (parsed?.action === 'skip') {
      return { action: 'skip', skipped: true, finalText: null, responses: [], reason: String(parsed.reason ?? '') }
    }
    if (['send', 'react'].includes(parsed?.action) && typeof parsed.text === 'string') {
      const hasRootText = Boolean(parsed.text.trim())
      const responses = hasRootText
        ? []
        : normalizeResponses(parsed.responses)
      if (!hasRootText && (parsed.action === 'react' || responses === null)) return null
      return {
        action: parsed.action,
        skipped: false,
        finalText: parsed.text,
        responses,
        reason: String(parsed.reason ?? ''),
      }
    }
    return null
  }

  try {
    const envelope = parseEnvelope(text)
    if (envelope) return envelope
  } catch {}

  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth !== 0) continue
        try {
          const envelope = parseEnvelope(trimmed.slice(0, index + 1))
          if (envelope) return envelope
        } catch {}
        break
      }
    }
    return malformed()
  }
  const skip = text.match(/^\s*\[SKIP\](?:\s+理由[:：]?)?\s*(.*)$/isu)
  if (skip) return { action: 'skip', skipped: true, finalText: null, responses: [], reason: skip[1].trim() }
  return { action: 'send', skipped: false, finalText: text, responses: [], reason: 'unstructured_compatibility_output' }
}

class TurnCollector {
  #client
  #threadId
  #items = new Map()
  #completions = new Map()
  #waiters = new Map()
  #started = new Set()
  #startWaiters = new Map()
  #onItem
  #onTurn
  #onStarted
  #onFailure
  #failure = null

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
    this.#onStarted = params => {
      if (params.threadId !== this.#threadId || !params.turn?.id) return
      const turnId = params.turn.id
      this.#started.add(turnId)
      const waiter = this.#startWaiters.get(turnId)
      if (!waiter) return
      this.#startWaiters.delete(turnId)
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.#onFailure = error => {
      if (this.#failure) return
      this.#failure = error
      for (const waiter of this.#waiters.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.#waiters.clear()
      for (const waiter of this.#startWaiters.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.#startWaiters.clear()
    }
    client.on('notification:item/completed', this.#onItem)
    client.on('notification:turn/completed', this.#onTurn)
    client.on('notification:turn/started', this.#onStarted)
    client.on('close', this.#onFailure)
    client.on('protocolError', this.#onFailure)
  }

  wait(turnId, timeoutMs, onTimeout) {
    if (this.#failure) return Promise.reject(this.#failure)
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

  waitStarted(turnId, timeoutMs) {
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#started.has(turnId)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#startWaiters.delete(turnId)
        reject(new Error(`timed out waiting for Codex turn ${turnId} to start`))
      }, timeoutMs)
      timer.unref?.()
      this.#startWaiters.set(turnId, { resolve, reject, timer })
    })
  }

  dispose(error = new Error('turn collector disposed')) {
    this.#client.off('notification:item/completed', this.#onItem)
    this.#client.off('notification:turn/completed', this.#onTurn)
    this.#client.off('notification:turn/started', this.#onStarted)
    this.#client.off('close', this.#onFailure)
    this.#client.off('protocolError', this.#onFailure)
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#waiters.clear()
    for (const waiter of this.#startWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#startWaiters.clear()
  }
}

export class CodexRunner {
  #client
  #state
  #config
  #activeTurns = new Map()
  #startingConversations = new Set()
  #pendingInterrupts = new Set()

  constructor({ client, stateStore, config }) {
    this.#client = client
    this.#state = stateStore
    this.#config = config
  }

  #threadOverrides(ownerDm, conversation) {
    return compact({
      model: conversation?.modelOverride ?? this.#config.model,
      cwd: this.#config.codexWorkdir,
      approvalPolicy: ownerDm ? 'on-request' : 'never',
      approvalsReviewer: ownerDm ? 'user' : null,
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
    const trust = ownerDm
      ? TELEGRAM_TRUST.OWNER_DM
      : classifyTelegramContext(
          telegramContext,
          this.#config.ownerUserId,
          this.#config.privateChatIds,
          this.#config.repairChatIds,
        )
    const instructionSource = isInstructionTrust(trust)
    this.#startingConversations.add(conversationKey)
    let thread
    try {
      thread = await this.#getOrCreateThread(conversationKey, ownerDm)
    } catch (error) {
      this.#startingConversations.delete(conversationKey)
      this.#pendingInterrupts.delete(conversationKey)
      throw error
    }
    const collector = new TurnCollector(this.#client, thread.threadId)
    let turnId = null
    let activeTurnId = null
    try {
      const sourceId = clientUserMessageId ?? null
      const startingTurnId = `starting:${sourceId ?? `${thread.threadId}:${Date.now()}`}`
      this.#state.beginActiveTurn({
        conversationKey,
        placeholderTurnId: startingTurnId,
        sourceId,
      })
      activeTurnId = startingTurnId
      this.#startingConversations.delete(conversationKey)
      const turnResponse = await this.#client.request('turn/start', compact({
        threadId: thread.threadId,
        input: buildInput(`${externalFeedTag(trust)}\n${text}`, attachments),
        clientUserMessageId,
        model: thread.conversation?.modelOverride ?? this.#config.model,
        effort: thread.conversation?.effortOverride ?? this.#config.effort,
        cwd: this.#config.codexWorkdir,
        approvalPolicy: instructionSource ? 'on-request' : 'never',
        approvalsReviewer: instructionSource ? 'user' : null,
        runtimeWorkspaceRoots: instructionSource ? this.#config.codexWritableRoots : [],
        sandboxPolicy: instructionSource
          ? {
              type: 'workspaceWrite',
              writableRoots: this.#config.codexWritableRoots,
              networkAccess: false,
            }
          : { type: 'readOnly', networkAccess: false },
        additionalContext: {
          telegram: { kind: 'untrusted', value: JSON.stringify(telegramContext) },
          telegram_source: { kind: 'application', value: externalFeedTag(trust) },
          telegram_trust_policy: { kind: 'application', value: TELEGRAM_TRUST_POLICIES[trust] },
          telegram_output_contract: { kind: 'application', value: TELEGRAM_OUTPUT_INSTRUCTIONS },
        },
        outputSchema: TELEGRAM_OUTPUT_SCHEMA,
      }))
      turnId = turnResponse.turn.id
      if (!this.#state.replaceActiveTurn({
        conversationKey,
        expectedTurnId: activeTurnId,
        turnId,
      })) throw new Error(`failed to persist active Codex turn ${turnId}`)
      activeTurnId = turnId
      const active = {
        conversationKey,
        threadId: thread.threadId,
        turnId,
        collector,
        interruptPromise: null,
      }
      this.#activeTurns.set(conversationKey, active)
      if (this.#pendingInterrupts.delete(conversationKey)) await this.#interruptActive(active)

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
      const output = guardTelegramOutput(parseTelegramStructuredOutput(extractFinal(items)), trust)
      const actionIds = [...findActionIds(items.filter(item => item?.type === 'mcpToolCall' && item.server === 'telegram'))]
      return {
        threadId: thread.threadId,
        turnId,
        finalText: output.finalText,
        action: output.action,
        responses: output.responses,
        skipped: output.skipped,
        reason: output.reason,
        sentActionIds: actionIds,
        contextBreak: thread.contextBreak,
        replacedThreadId: thread.replacedThreadId,
      }
    } catch (error) {
      const definitivelyRejected = turnId === null
        && error instanceof AppServerRpcError
        && error.code !== 'TIMEOUT'
      if (activeTurnId && !definitivelyRejected) error.turnAccepted = true
      throw error
    } finally {
      this.#startingConversations.delete(conversationKey)
      const active = this.#activeTurns.get(conversationKey)
      if (active?.turnId === turnId) this.#activeTurns.delete(conversationKey)
      this.#pendingInterrupts.delete(conversationKey)
      if (activeTurnId) this.#state.clearActiveTurn({ conversationKey, turnId: activeTurnId })
      collector.dispose()
    }
  }

  async interrupt(conversationKey) {
    const active = this.#activeTurns.get(conversationKey)
    if (active) {
      await this.#interruptActive(active)
      return true
    }
    if (this.#startingConversations.has(conversationKey)) {
      this.#pendingInterrupts.add(conversationKey)
      return true
    }
    const conversation = this.#state.getConversation(conversationKey)
    if (!conversation?.threadId || !conversation.activeTurnId) return false
    if (conversation.activeTurnId.startsWith('starting:')) {
      this.#pendingInterrupts.add(conversationKey)
      return true
    }
    await this.#client.request('turn/interrupt', {
      threadId: conversation.threadId,
      turnId: conversation.activeTurnId,
    })
    this.#state.clearActiveTurn({ conversationKey, turnId: conversation.activeTurnId })
    return true
  }

  #interruptActive(active) {
    if (!active.interruptPromise) {
      active.interruptPromise = (async () => {
        await active.collector.waitStarted(active.turnId, Math.min(this.#config.turnTimeoutMs, 30_000))
        await this.#client.request('turn/interrupt', {
          threadId: active.threadId,
          turnId: active.turnId,
        })
        this.#state.clearActiveTurn({
          conversationKey: active.conversationKey,
          turnId: active.turnId,
        })
      })()
    }
    return active.interruptPromise
  }

  async recoverInterruptedTurns() {
    let recovered = 0
    for (const conversation of this.#state.listActiveConversations()) {
      if (!conversation.activeTurnId.startsWith('starting:')) {
        try {
          await this.#client.request('turn/interrupt', {
            threadId: conversation.threadId,
            turnId: conversation.activeTurnId,
          })
        } catch (error) {
          const alreadyInactive = error instanceof AppServerRpcError
            && /(turn|thread).{0,50}(missing|not found|not active|already (?:completed|stopped|interrupted))/iu.test(error.message)
          if (!alreadyInactive) throw error
        }
      }
      if (conversation.activeSourceId) {
        this.#state.failUncertainSource(
          conversation.activeSourceId,
          'bridge restart interrupted an accepted Codex turn; outcome unknown and automatic replay disabled',
        )
      }
      if (this.#state.clearActiveTurn({
        conversationKey: conversation.conversationKey,
        turnId: conversation.activeTurnId,
      })) recovered += 1
    }
    return recovered
  }
}
