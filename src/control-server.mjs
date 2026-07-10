import { basename } from 'node:path'

import { JsonLineSocketServer } from './json-line-socket.mjs'

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u

function requiredString(value, name, maxLength = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string up to ${maxLength} characters`)
  }
  return value
}

function threadId(conversationKey) {
  const index = conversationKey.lastIndexOf(':')
  return index === -1 ? null : conversationKey.slice(index + 1)
}

export class ControlServer {
  #state
  #dispatcher
  #attachmentStore
  #server

  constructor({ socketPath, stateStore, dispatcher, attachmentStore }) {
    this.#state = stateStore
    this.#dispatcher = dispatcher
    this.#attachmentStore = attachmentStore
    this.#server = new JsonLineSocketServer({
      socketPath,
      handler: request => this.#handle(request),
    })
  }

  start() {
    return this.#server.start()
  }

  close() {
    return this.#server.close()
  }

  #resolveTarget(target) {
    requiredString(target, 'target', 128)
    const chat = this.#state.getApprovedChatByAlias(target) ?? this.#state.getApprovedChat(target)
    if (!chat) throw new Error('unknown or unapproved Telegram target')
    return chat
  }

  async #handle(request) {
    const { action, params = {}, actionId } = request
    if (!ACTION_ID.test(actionId ?? '')) throw new Error('invalid actionId')
    if (action === 'list_chats') {
      return this.#state.listApprovedChats().map(chat => ({
        alias: chat.alias,
        conversationKey: chat.conversationKey,
        title: chat.title,
        kind: chat.kind,
      }))
    }

    const chat = this.#resolveTarget(params.target)
    const base = {
      chatId: chat.telegramChatId,
      threadId: threadId(chat.conversationKey),
    }
    let actionType
    let payload
    if (action === 'send_text') {
      actionType = 'send_text'
      payload = { ...base, text: requiredString(params.text, 'text') }
    } else if (action === 'reply') {
      actionType = 'reply'
      payload = {
        ...base,
        messageId: requiredString(params.messageId, 'messageId', 32),
        text: requiredString(params.text, 'text'),
      }
    } else if (action === 'edit_own_message') {
      actionType = 'edit_own_message'
      payload = {
        ...base,
        messageId: requiredString(params.messageId, 'messageId', 32),
        text: requiredString(params.text, 'text'),
      }
    } else if (action === 'delete_own_message') {
      actionType = 'delete_own_message'
      payload = { ...base, messageId: requiredString(params.messageId, 'messageId', 32) }
    } else if (action === 'react') {
      actionType = 'react'
      payload = {
        ...base,
        messageId: requiredString(params.messageId, 'messageId', 32),
        reaction: params.reaction,
      }
    } else if (action === 'send_file') {
      const path = await this.#attachmentStore.assertExportPath(requiredString(params.path, 'path', 4096))
      actionType = 'send_file'
      payload = {
        ...base,
        path,
        fileName: basename(path),
        kind: params.kind === 'photo' ? 'photo' : 'document',
        caption: params.caption ?? null,
      }
    } else {
      throw new Error(`unsupported Telegram action: ${action}`)
    }

    const result = await this.#dispatcher.enqueueExternalAction({
      actionId,
      conversationKey: chat.conversationKey,
      actionType,
      payload,
    })
    return {
      actionId: result.actionId ?? actionId,
      status: result.status,
      telegramMessageId: result.telegramMessageId ?? null,
    }
  }
}
