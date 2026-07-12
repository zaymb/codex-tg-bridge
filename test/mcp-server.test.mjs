import assert from 'node:assert/strict'
import test from 'node:test'

import { TELEGRAM_TOOL_NAMES, buildTelegramToolHandlers, createTelegramMcpServer } from '../src/mcp-server.mjs'

test('registers exactly eight Telegram action tools and no wake tool', () => {
  assert.deepEqual(TELEGRAM_TOOL_NAMES, [
    'telegram_send_text',
    'telegram_send_file',
    'telegram_reply',
    'telegram_edit_own_message',
    'telegram_delete_own_message',
    'telegram_react',
    'telegram_send_dice',
    'telegram_list_chats',
  ])
  assert.equal(TELEGRAM_TOOL_NAMES.includes('telegram_enqueue_wake'), false)
  const server = createTelegramMcpServer({ controlClient: {} })
  assert.deepEqual(Object.keys(server._registeredTools), TELEGRAM_TOOL_NAMES)
})

test('maps MCP tool calls to the narrow control protocol with stable action IDs', async () => {
  const calls = []
  let counter = 0
  const controlClient = {
    async request(action, params, options) {
      calls.push({ action, params, options })
      return { status: 'sent', actionId: options.actionId }
    },
  }
  const handlers = buildTelegramToolHandlers({
    controlClient,
    actionIdFactory: tool => `${tool}-${++counter}`,
  })

  const result = await handlers.telegram_reply({ target: 'sandbox', message_id: '55', text: 'hello' })

  assert.deepEqual(calls, [{
    action: 'reply',
    params: { target: 'sandbox', messageId: '55', text: 'hello' },
    options: { actionId: 'telegram_reply-1' },
  }])
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'Telegram reply sent.' }],
    structuredContent: { status: 'sent', actionId: 'telegram_reply-1' },
  })
})

test('maps animated dice to the narrow control protocol', async () => {
  const calls = []
  const controlClient = {
    async request(action, params, options) {
      calls.push({ action, params, options })
      return { status: 'sent', actionId: options.actionId }
    },
  }
  const handlers = buildTelegramToolHandlers({
    controlClient,
    actionIdFactory: () => 'dice-action-1',
  })

  await handlers.telegram_send_dice({ target: 'sandbox', emoji: '🎰', reply_to_message_id: '55' })

  assert.deepEqual(calls, [{
    action: 'send_dice',
    params: { target: 'sandbox', emoji: '🎰', messageId: '55' },
    options: { actionId: 'dice-action-1' },
  }])
})
