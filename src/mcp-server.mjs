#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { ControlClient } from './control-client.mjs'

export const TELEGRAM_TOOL_NAMES = Object.freeze([
  'telegram_send_text',
  'telegram_send_file',
  'telegram_reply',
  'telegram_edit_own_message',
  'telegram_delete_own_message',
  'telegram_react',
  'telegram_send_dice',
  'telegram_list_chats',
])

function toolResult(label, result) {
  return {
    content: [{ type: 'text', text: label }],
    structuredContent: result,
  }
}

export function buildTelegramToolHandlers({ controlClient, actionIdFactory = tool => `${tool}:${randomUUID()}` }) {
  const call = async (tool, action, params, label) => {
    const actionId = actionIdFactory(tool)
    const result = await controlClient.request(action, params, { actionId })
    return toolResult(label, result)
  }
  return {
    telegram_send_text: ({ target, text }) => call('telegram_send_text', 'send_text', { target, text }, 'Telegram text sent.'),
    telegram_send_file: ({ target, path, kind = 'document', caption }) => call(
      'telegram_send_file',
      'send_file',
      { target, path, kind, caption },
      'Telegram file sent.',
    ),
    telegram_reply: ({ target, message_id, text }) => call(
      'telegram_reply',
      'reply',
      { target, messageId: message_id, text },
      'Telegram reply sent.',
    ),
    telegram_edit_own_message: ({ target, message_id, text }) => call(
      'telegram_edit_own_message',
      'edit_own_message',
      { target, messageId: message_id, text },
      'Telegram message edited.',
    ),
    telegram_delete_own_message: ({ target, message_id }) => call(
      'telegram_delete_own_message',
      'delete_own_message',
      { target, messageId: message_id },
      'Telegram message deleted.',
    ),
    telegram_react: ({ target, message_id, reaction }) => call(
      'telegram_react',
      'react',
      { target, messageId: message_id, reaction },
      'Telegram reaction sent.',
    ),
    telegram_send_dice: ({ target, emoji = '🎲', reply_to_message_id }) => call(
      'telegram_send_dice',
      'send_dice',
      { target, emoji, messageId: reply_to_message_id },
      'Telegram dice sent.',
    ),
    telegram_list_chats: async () => {
      const chats = await controlClient.request('list_chats', {}, { actionId: actionIdFactory('telegram_list_chats') })
      return toolResult(JSON.stringify(chats), { chats })
    },
  }
}

export function createTelegramMcpServer({ controlClient }) {
  const server = new McpServer({ name: 'tg-engage-telegram-actions', version: '0.1.0' })
  const handlers = buildTelegramToolHandlers({ controlClient })
  const target = z.string().min(1).max(128).describe('Approved Telegram chat alias, conversation key, or unique known topic name')
  const messageId = z.string().regex(/^\d+$/u)
  server.registerTool('telegram_send_text', {
    description: 'Send one final text message to an approved Telegram chat.',
    inputSchema: { target, text: z.string().min(1).max(4096) },
  }, handlers.telegram_send_text)
  server.registerTool('telegram_send_file', {
    description: 'Send a file from a configured export root to an approved Telegram chat.',
    inputSchema: {
      target,
      path: z.string().min(1),
      kind: z.enum(['document', 'photo']).default('document'),
      caption: z.string().max(1024).optional(),
    },
  }, handlers.telegram_send_file)
  server.registerTool('telegram_reply', {
    description: 'Reply to a Telegram message in an approved chat.',
    inputSchema: { target, message_id: messageId, text: z.string().min(1).max(4096) },
  }, handlers.telegram_reply)
  server.registerTool('telegram_edit_own_message', {
    description: 'Edit a message previously sent by this bot.',
    inputSchema: { target, message_id: messageId, text: z.string().min(1).max(4096) },
  }, handlers.telegram_edit_own_message)
  server.registerTool('telegram_delete_own_message', {
    description: 'Delete a message previously sent by this bot.',
    inputSchema: { target, message_id: messageId },
  }, handlers.telegram_delete_own_message)
  server.registerTool('telegram_react', {
    description: 'Set one non-paid reaction on a Telegram message.',
    inputSchema: {
      target,
      message_id: messageId,
      reaction: z.union([
        z.object({ type: z.literal('emoji'), emoji: z.string().min(1) }),
        z.object({ type: z.literal('custom_emoji'), customEmojiId: z.string().min(1) }),
      ]),
    },
  }, handlers.telegram_react)
  server.registerTool('telegram_send_dice', {
    description: 'Send one Telegram animated dice, dart, ball, bowling, or slot-machine message.',
    inputSchema: {
      target,
      emoji: z.enum(['🎲', '🎯', '🏀', '⚽', '🎳', '🎰']).default('🎲'),
      reply_to_message_id: messageId.optional(),
    },
  }, handlers.telegram_send_dice)
  server.registerTool('telegram_list_chats', {
    description: 'List approved Telegram chat aliases available to this Codex runtime.',
    inputSchema: {},
  }, handlers.telegram_list_chats)
  return server
}

async function main() {
  const socketPath = process.env.BRIDGE_ACTION_SOCKET
  if (!socketPath) throw new Error('BRIDGE_ACTION_SOCKET is required')
  const controlClient = await ControlClient.connect({ socketPath })
  const server = createTelegramMcpServer({ controlClient })
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
