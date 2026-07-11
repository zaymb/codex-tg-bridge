import { createHash, randomBytes, randomUUID } from 'node:crypto'

const SUPPORTED_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function responseFor(method, params, approved) {
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: approved ? params.permissions ?? {} : {},
      scope: 'turn',
    }
  }
  return { decision: approved ? 'accept' : 'decline' }
}

function detailFor(method, params) {
  if (method === 'item/commandExecution/requestApproval') {
    const network = params.networkApprovalContext
      ? `Network: ${params.networkApprovalContext.protocol ?? '?'}://${params.networkApprovalContext.host ?? '?'}`
      : null
    return [
      'Codex requests command execution approval.',
      params.reason ? `Reason: ${params.reason}` : null,
      params.command ? `Command: ${params.command}` : null,
      params.cwd ? `Cwd: ${params.cwd}` : null,
      network,
    ].filter(Boolean).join('\n')
  }
  if (method === 'item/fileChange/requestApproval') {
    return [
      'Codex requests file change approval.',
      params.reason ? `Reason: ${params.reason}` : null,
      params.grantRoot ? `Grant root: ${params.grantRoot}` : null,
    ].filter(Boolean).join('\n')
  }
  return [
    'Codex requests additional permissions for this turn.',
    params.reason ? `Reason: ${params.reason}` : null,
    params.cwd ? `Cwd: ${params.cwd}` : null,
    `Requested: ${JSON.stringify(params.permissions ?? {})}`,
  ].filter(Boolean).join('\n')
}

export class ApprovalRouter {
  #client
  #state
  #telegram
  #ownerUserId
  #approvalTtlMs
  #clock
  #tokenFactory
  #pending = new Map()
  #boundRequest = null
  #connectionId = randomUUID()

  constructor({
    appServerClient,
    stateStore,
    telegramClient,
    ownerUserId,
    approvalTtlMs = 10 * 60 * 1_000,
    clock = Date.now,
    tokenFactory = () => randomBytes(24).toString('base64url'),
  }) {
    this.#client = appServerClient
    this.#state = stateStore
    this.#telegram = telegramClient
    this.#ownerUserId = String(ownerUserId)
    this.#approvalTtlMs = approvalTtlMs
    this.#clock = clock
    this.#tokenFactory = tokenFactory
  }

  start() {
    if (this.#boundRequest) return
    this.#boundRequest = request => {
      this.handleServerRequest(request).catch(() => {
        try {
          this.#client.respond(request.id, null, {
            code: -32603,
            message: 'Approval routing failed closed',
          })
        } catch {}
      })
    }
    this.#client.on('request', this.#boundRequest)
  }

  stop() {
    if (!this.#boundRequest) return
    this.#client.off('request', this.#boundRequest)
    this.#boundRequest = null
  }

  async handleServerRequest(request) {
    if (!SUPPORTED_METHODS.has(request.method)) {
      this.#client.respond(request.id, null, {
        code: -32601,
        message: `Unsupported app-server request: ${request.method}`,
      })
      return false
    }

    const params = request.params ?? {}
    const conversation = params.threadId
      ? this.#state.getConversationByThreadId(params.threadId)
      : null
    if (!conversation || !params.turnId) {
      this.#client.respond(request.id, responseFor(request.method, params, false))
      return false
    }

    const token = this.#tokenFactory()
    if (!/^[A-Za-z0-9_-]{8,48}$/u.test(token)) throw new Error('approval token factory returned an invalid token')
    const tokenHash = hashToken(token)
    const nowMs = this.#clock()
    const responseOnDeny = responseFor(request.method, params, false)
    this.#state.createApproval({
      tokenHash,
      requestId: `${this.#connectionId}:${request.id}`,
      method: request.method,
      conversationKey: conversation.conversationKey,
      threadId: params.threadId,
      turnId: params.turnId,
      ownerUserId: this.#ownerUserId,
      expiresAtMs: nowMs + this.#approvalTtlMs,
      nowMs,
    })
    this.#pending.set(tokenHash, { request, conversationKey: conversation.conversationKey })

    const approveData = `ap:${token}:approve`
    const denyData = `ap:${token}:deny`
    if (approveData.length > 64 || denyData.length > 64) throw new Error('approval callback data exceeds Telegram limit')
    try {
      await this.#telegram.sendText({
        chatId: this.#ownerUserId,
        text: `${detailFor(request.method, params).slice(0, 3000)}\n\nConversation: ${conversation.conversationKey}`,
        replyMarkup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: approveData },
            { text: 'Deny', callback_data: denyData },
          ]],
        },
      })
      return true
    } catch (error) {
      this.#state.resolveApproval({
        tokenHash,
        ownerUserId: this.#ownerUserId,
        decision: 'denied',
        response: responseOnDeny,
        nowMs: this.#clock(),
      })
      this.#pending.delete(tokenHash)
      this.#client.respond(request.id, responseOnDeny)
      throw error
    }
  }

  async #ack(callbackQueryId, text, showAlert = false) {
    await this.#telegram.answerCallbackQuery({ callbackQueryId, text, showAlert })
  }

  async handleCallback(update) {
    const callbackId = update?.callback?.id
    const data = update?.callback?.data ?? ''
    if (!callbackId) return false
    if (
      update.actor?.id !== this.#ownerUserId
      || update.chat?.type !== 'private'
      || update.chat?.id !== this.#ownerUserId
    ) {
      await this.#ack(callbackId, 'Not authorized', true)
      return false
    }

    const match = data.match(/^ap:([A-Za-z0-9_-]{8,48}):(approve|deny)$/u)
    if (!match) {
      await this.#ack(callbackId, 'Unknown approval action', true)
      return false
    }
    const tokenHash = hashToken(match[1])
    const pending = this.#pending.get(tokenHash)
    if (!pending) {
      await this.#ack(callbackId, 'Approval is no longer active', true)
      return false
    }

    const { request, conversationKey } = pending
    const params = request.params ?? {}
    const approved = match[2] === 'approve'
    const denialResponse = responseFor(request.method, params, false)
    const conversation = this.#state.getConversation(conversationKey)
    if (
      !conversation
      || conversation.threadId !== params.threadId
      || conversation.activeTurnId !== params.turnId
    ) {
      this.#state.resolveApproval({
        tokenHash,
        ownerUserId: this.#ownerUserId,
        decision: 'denied',
        response: denialResponse,
        nowMs: this.#clock(),
      })
      this.#pending.delete(tokenHash)
      this.#client.respond(request.id, denialResponse)
      await this.#ack(callbackId, 'Approval context changed; denied', true)
      return false
    }

    const appServerResponse = responseFor(request.method, params, approved)
    const resolution = this.#state.resolveApproval({
      tokenHash,
      ownerUserId: this.#ownerUserId,
      decision: approved ? 'approved' : 'denied',
      response: appServerResponse,
      nowMs: this.#clock(),
    })
    if (!resolution.resolved) {
      if (resolution.reason === 'expired') {
        this.#pending.delete(tokenHash)
        this.#client.respond(request.id, denialResponse)
        await this.#ack(callbackId, 'Approval expired', true)
      } else {
        await this.#ack(callbackId, 'Approval is no longer active', true)
      }
      return false
    }

    this.#pending.delete(tokenHash)
    this.#client.respond(request.id, appServerResponse)
    await this.#ack(callbackId, approved ? 'Approved' : 'Denied')
    return true
  }

  async expirePending() {
    let expired = 0
    const nowMs = this.#clock()
    for (const [tokenHash, pending] of [...this.#pending]) {
      const approval = this.#state.getApproval(tokenHash)
      if (!approval || approval.state !== 'pending' || approval.expiresAtMs > nowMs) continue
      const denialResponse = responseFor(pending.request.method, pending.request.params ?? {}, false)
      this.#state.resolveApproval({
        tokenHash,
        ownerUserId: this.#ownerUserId,
        decision: 'denied',
        response: denialResponse,
        nowMs,
      })
      this.#pending.delete(tokenHash)
      this.#client.respond(pending.request.id, denialResponse)
      expired += 1
    }
    return expired
  }
}
