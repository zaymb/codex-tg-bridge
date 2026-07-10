import { redact, redactError } from './redact.mjs'

export const ALLOWED_UPDATES = Object.freeze([
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'message_reaction',
  'message_reaction_count',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
])

export class TelegramApiError extends Error {
  constructor(message, { method, code, parameters = null } = {}) {
    super(message)
    this.name = 'TelegramApiError'
    this.method = method
    this.code = code
    this.parameters = parameters
  }
}

export class DuplicatePollerError extends TelegramApiError {
  constructor(message, options) {
    super(message, options)
    this.name = 'DuplicatePollerError'
  }
}

export class RateLimitError extends TelegramApiError {
  constructor(message, options) {
    super(message, options)
    this.name = 'RateLimitError'
    this.retryAfterSec = options.parameters?.retry_after ?? 1
  }
}

export class TelegramTransportError extends Error {
  constructor(message, { method, deliveryAmbiguous = false, cause } = {}) {
    super(message, { cause })
    this.name = 'TelegramTransportError'
    this.method = method
    this.deliveryAmbiguous = deliveryAmbiguous
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
}

function validateReaction(reaction) {
  if (!reaction || Array.isArray(reaction) || typeof reaction !== 'object') {
    throw new Error('Telegram requires exactly one reaction object')
  }
  if (reaction.type === 'paid') throw new Error('paid reactions are not supported')
  if (reaction.type === 'emoji' && typeof reaction.emoji === 'string' && reaction.emoji) {
    return { type: 'emoji', emoji: reaction.emoji }
  }
  if (reaction.type === 'custom_emoji' && typeof reaction.customEmojiId === 'string' && reaction.customEmojiId) {
    return { type: 'custom_emoji', custom_emoji_id: reaction.customEmojiId }
  }
  throw new Error('unsupported Telegram reaction object')
}

export class TelegramClient {
  #tokenReader
  #fetch
  #baseUrl

  constructor({ tokenReader, fetchImpl = globalThis.fetch, baseUrl = 'https://api.telegram.org' }) {
    if (typeof tokenReader !== 'function') throw new Error('tokenReader is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.#tokenReader = tokenReader
    this.#fetch = fetchImpl
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
  }

  async #request(method, payload = {}, { multipart = false, ambiguousOnTransport = false, signal } = {}) {
    const token = this.#tokenReader()
    const url = `${this.#baseUrl}/bot${token}/${method}`
    const options = { method: 'POST', signal }
    if (multipart) {
      options.body = payload
    } else {
      options.headers = { 'content-type': 'application/json' }
      options.body = JSON.stringify(compact(payload))
    }

    let response
    try {
      response = await this.#fetch(url, options)
    } catch (error) {
      const safeMessage = redact(error?.message ?? String(error), { credentials: [token] })
      const safeCause = error instanceof Error
        ? redactError(error, { credentials: [token] })
        : new Error(safeMessage)
      throw new TelegramTransportError(`Telegram transport failed for ${method}: ${safeMessage}`, {
        method,
        deliveryAmbiguous: ambiguousOnTransport,
        cause: safeCause,
      })
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new TelegramApiError(`Telegram ${method} returned non-JSON HTTP ${response.status}`, {
        method,
        code: response.status,
      })
    }
    if (response.ok && body.ok === true) return body.result

    const code = body.error_code ?? response.status
    const parameters = body.parameters ?? null
    const description = redact(body.description ?? `HTTP ${response.status}`, { credentials: [token] })
    const message = `Telegram ${method} failed (${code}): ${description}`
    const optionsForError = { method, code, parameters }
    if (code === 409 && method === 'getUpdates') throw new DuplicatePollerError(message, optionsForError)
    if (code === 429) throw new RateLimitError(message, optionsForError)
    throw new TelegramApiError(message, optionsForError)
  }

  getUpdates({ offset = null, timeoutSec = 50, allowedUpdates = ALLOWED_UPDATES, signal } = {}) {
    return this.#request('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: allowedUpdates,
    }, { signal })
  }

  sendText({ chatId, text, threadId = null, replyMarkup = null }) {
    return this.#request('sendMessage', {
      chat_id: String(chatId),
      text,
      message_thread_id: threadId === null ? null : String(threadId),
      reply_markup: replyMarkup,
    }, { ambiguousOnTransport: true })
  }

  reply({ chatId, messageId, text, threadId = null, replyMarkup = null }) {
    return this.#request('sendMessage', {
      chat_id: String(chatId),
      text,
      message_thread_id: threadId === null ? null : String(threadId),
      reply_parameters: { message_id: String(messageId) },
      reply_markup: replyMarkup,
    }, { ambiguousOnTransport: true })
  }

  editOwnMessage({ chatId, messageId, text, replyMarkup = null }) {
    return this.#request('editMessageText', {
      chat_id: String(chatId),
      message_id: String(messageId),
      text,
      reply_markup: replyMarkup,
    }, { ambiguousOnTransport: true })
  }

  deleteOwnMessage({ chatId, messageId }) {
    return this.#request('deleteMessage', {
      chat_id: String(chatId),
      message_id: String(messageId),
    }, { ambiguousOnTransport: true })
  }

  sendChatAction({ chatId, action = 'typing', threadId = null }) {
    return this.#request('sendChatAction', {
      chat_id: String(chatId),
      action,
      message_thread_id: threadId === null ? null : String(threadId),
    })
  }

  answerCallbackQuery({ callbackQueryId, text = null, showAlert = false }) {
    return this.#request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    })
  }

  async react({ chatId, messageId, reaction, isBig = false }) {
    const normalized = validateReaction(reaction)
    return this.#request('setMessageReaction', {
      chat_id: String(chatId),
      message_id: String(messageId),
      reaction: [normalized],
      is_big: isBig,
    }, { ambiguousOnTransport: true })
  }

  sendFile({
    chatId,
    bytes,
    fileName,
    mimeType = 'application/octet-stream',
    kind = 'document',
    caption = null,
    threadId = null,
    replyToMessageId = null,
  }) {
    if (!['document', 'photo'].includes(kind)) throw new Error('file kind must be document or photo')
    const field = kind === 'photo' ? 'photo' : 'document'
    const method = kind === 'photo' ? 'sendPhoto' : 'sendDocument'
    const form = new FormData()
    form.set('chat_id', String(chatId))
    form.set(field, new Blob([bytes], { type: mimeType }), fileName)
    if (caption !== null) form.set('caption', caption)
    if (threadId !== null) form.set('message_thread_id', String(threadId))
    if (replyToMessageId !== null) {
      form.set('reply_parameters', JSON.stringify({ message_id: String(replyToMessageId) }))
    }
    return this.#request(method, form, { multipart: true, ambiguousOnTransport: true })
  }

  getFile(fileId) {
    return this.#request('getFile', { file_id: fileId })
  }

  async downloadFile(fileId, { signal } = {}) {
    const metadata = await this.getFile(fileId)
    if (!metadata?.file_path) throw new TelegramApiError('Telegram getFile returned no file_path', { method: 'getFile' })
    const token = this.#tokenReader()
    const url = `${this.#baseUrl}/file/bot${token}/${metadata.file_path}`
    let response
    try {
      response = await this.#fetch(url, { method: 'GET', signal })
    } catch (error) {
      const safeMessage = redact(error?.message ?? String(error), { credentials: [token] })
      const safeCause = error instanceof Error
        ? redactError(error, { credentials: [token] })
        : new Error(safeMessage)
      throw new TelegramTransportError(`Telegram file download failed: ${safeMessage}`, {
        method: 'downloadFile',
        deliveryAmbiguous: false,
        cause: safeCause,
      })
    }
    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed with HTTP ${response.status}`, {
        method: 'downloadFile',
        code: response.status,
      })
    }
    return {
      filePath: metadata.file_path,
      bytes: Buffer.from(await response.arrayBuffer()),
      metadata,
    }
  }

  getWebhookInfo() {
    return this.#request('getWebhookInfo')
  }

  deleteWebhook({ dropPendingUpdates = false } = {}) {
    return this.#request('deleteWebhook', { drop_pending_updates: dropPendingUpdates })
  }
}
