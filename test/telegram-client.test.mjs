import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALLOWED_UPDATES,
  DuplicatePollerError,
  RateLimitError,
  TelegramApiError,
  TelegramClient,
  TelegramTransportError,
} from '../src/telegram-client.mjs'

const TOKEN = '123456:telegram-secret-token'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(handler) {
  const calls = []
  const client = new TelegramClient({
    tokenReader: () => TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return handler(url, options, calls.length - 1)
    },
  })
  return { client, calls }
}

test('long polls with a durable offset and an explicit allowed_updates surface', async () => {
  const { client, calls } = clientWith(() => jsonResponse({ ok: true, result: [{ update_id: 10 }] }))
  const updates = await client.getUpdates({ offset: '10', timeoutSec: 50 })

  assert.deepEqual(updates, [{ update_id: 10 }])
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/bot123456:telegram-secret-token\/getUpdates$/)
  const body = JSON.parse(calls[0].options.body)
  assert.deepEqual(body, { offset: '10', timeout: 50, allowed_updates: ALLOWED_UPDATES })
})

test('aborts a stuck long poll at its client-side deadline', async () => {
  const { client } = clientWith((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(options.signal.reason)
    }, { once: true })
  }))

  await assert.rejects(
    client.getUpdates({ timeoutSec: 50, requestTimeoutMs: 20 }),
    error => {
      assert.equal(error.name, 'TelegramTransportError')
      assert.equal(error.method, 'getUpdates')
      assert.match(error.cause.message, /client deadline/)
      return true
    },
  )
})

test('reads the bot identity for mention and self-message routing', async () => {
  const { client, calls } = clientWith(() => jsonResponse({
    ok: true,
    result: { id: 500, is_bot: true, username: 'bridge_bot', first_name: 'Bridge' },
  }))

  assert.equal((await client.getMe()).username, 'bridge_bot')
  assert.equal(calls[0].url.endsWith('/getMe'), true)
})

test('sends text, reply, edit, delete, typing, and callback acknowledgement', async () => {
  const { client, calls } = clientWith((url, options) => {
    const method = url.split('/').at(-1)
    return jsonResponse({ ok: true, result: method === 'sendMessage' ? { message_id: 55 } : true })
  })

  await client.sendText({ chatId: '-100123', text: 'hello', threadId: '7' })
  await client.reply({ chatId: '-100123', messageId: '54', text: 'reply', threadId: '7' })
  await client.editOwnMessage({ chatId: '-100123', messageId: '55', text: 'edited' })
  await client.deleteOwnMessage({ chatId: '-100123', messageId: '55' })
  await client.sendChatAction({ chatId: '-100123', action: 'typing', threadId: '7' })
  await client.answerCallbackQuery({ callbackQueryId: 'callback-1', text: 'Done' })

  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), [
    'sendMessage', 'sendMessage', 'editMessageText', 'deleteMessage', 'sendChatAction', 'answerCallbackQuery',
  ])
  assert.deepEqual(JSON.parse(calls[1].options.body).reply_parameters, { message_id: '54' })
  assert.equal(JSON.parse(calls[0].options.body).message_thread_id, '7')
})

test('sends Telegram animated dice with optional topic and reply routing', async () => {
  const { client, calls } = clientWith(() => jsonResponse({
    ok: true,
    result: { message_id: 56, chat: { id: -100123 }, dice: { emoji: '🎰', value: 64 } },
  }))

  await client.sendDice({
    chatId: '-100123',
    emoji: '🎰',
    threadId: '7',
    replyToMessageId: '55',
  })

  assert.equal(calls[0].url.endsWith('/sendDice'), true)
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: '-100123',
    emoji: '🎰',
    message_thread_id: '7',
    reply_parameters: { message_id: '55' },
  })
  assert.throws(() => client.sendDice({ chatId: '-100123', emoji: '🐭' }), /dice emoji must be one of/)
})

test('classifies 409 as a duplicate poller and 429 with retry_after', async () => {
  const duplicate = clientWith(() => jsonResponse({
    ok: false,
    error_code: 409,
    description: 'Conflict: terminated by other getUpdates request',
  }, 409)).client
  await assert.rejects(duplicate.getUpdates({ timeoutSec: 1 }), error => {
    assert.ok(error instanceof DuplicatePollerError)
    assert.equal(error.code, 409)
    return true
  })

  const limited = clientWith(() => jsonResponse({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: 17 },
  }, 429)).client
  await assert.rejects(limited.sendText({ chatId: '42', text: 'hello' }), error => {
    assert.ok(error instanceof RateLimitError)
    assert.equal(error.retryAfterSec, 17)
    return true
  })
})

test('redacts Bot API credentials from API and transport errors', async () => {
  const api = clientWith(() => jsonResponse({
    ok: false,
    error_code: 400,
    description: `bad token ${TOKEN} at https://api.telegram.org/bot${TOKEN}/sendMessage`,
  }, 400)).client
  await assert.rejects(api.sendText({ chatId: '42', text: 'hello' }), error => {
    assert.ok(error instanceof TelegramApiError)
    assert.doesNotMatch(error.message, /telegram-secret-token/)
    assert.match(error.message, /\[REDACTED\]/)
    return true
  })

  const transport = clientWith(() => {
    throw new Error(`socket failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)
  }).client
  await assert.rejects(transport.sendText({ chatId: '42', text: 'hello' }), error => {
    assert.ok(error instanceof TelegramTransportError)
    assert.equal(error.deliveryAmbiguous, true)
    assert.doesNotMatch(error.message, /telegram-secret-token/)
    assert.doesNotMatch(error.cause.message, /telegram-secret-token/)
    return true
  })
  await assert.rejects(transport.getUpdates({ timeoutSec: 1 }), error => {
    assert.ok(error instanceof TelegramTransportError)
    assert.equal(error.deliveryAmbiguous, false)
    return true
  })
})

test('sends document and photo multipart payloads', async () => {
  const { client, calls } = clientWith(() => jsonResponse({ ok: true, result: { message_id: 60 } }))
  await client.sendFile({
    chatId: '-100123',
    bytes: Buffer.from('document'),
    fileName: 'report.txt',
    mimeType: 'text/plain',
    kind: 'document',
    caption: 'Report',
    replyToMessageId: '55',
  })
  await client.sendFile({
    chatId: '-100123',
    bytes: Buffer.from('image'),
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    kind: 'photo',
  })

  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['sendDocument', 'sendPhoto'])
  assert.ok(calls[0].options.body instanceof FormData)
  assert.equal(calls[0].options.body.get('chat_id'), '-100123')
  assert.equal(calls[0].options.body.get('caption'), 'Report')
  assert.equal(calls[0].options.body.get('reply_parameters'), '{"message_id":"55"}')
  assert.equal(calls[0].options.body.get('document').name, 'report.txt')
  assert.equal(calls[1].options.body.get('photo').name, 'photo.jpg')
})

test('validates and sends one non-paid reaction', async () => {
  const { client, calls } = clientWith(() => jsonResponse({ ok: true, result: true }))
  await client.react({ chatId: '-100123', messageId: '55', reaction: { type: 'emoji', emoji: '👍' } })
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: '-100123',
    message_id: '55',
    reaction: [{ type: 'emoji', emoji: '👍' }],
    is_big: false,
  })
  await client.react({ chatId: '-100123', messageId: '56', reaction: { type: 'emoji', emoji: '❤️' } })
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    chat_id: '-100123',
    message_id: '56',
    reaction: [{ type: 'emoji', emoji: '❤️' }],
    is_big: false,
  })

  await assert.rejects(
    client.react({ chatId: '-100123', messageId: '55', reaction: { type: 'paid' } }),
    /paid reactions are not supported/,
  )
  await assert.rejects(
    client.react({ chatId: '-100123', messageId: '55', reaction: [{ type: 'emoji', emoji: '👍' }] }),
    /exactly one reaction object/,
  )
  await assert.rejects(
    client.react({ chatId: '-100123', messageId: '55', reaction: { type: 'emoji', emoji: '✅' } }),
    /not supported by Telegram ReactionTypeEmoji/,
  )
  assert.equal(calls.length, 2, 'unsupported emoji must fail before any Telegram request')
})

test('gets Telegram file metadata and downloads bytes without leaking the token in errors', async () => {
  const { client, calls } = clientWith((url, options) => {
    if (url.endsWith('/getFile')) return jsonResponse({ ok: true, result: { file_id: 'f', file_path: 'docs/a.txt' } })
    assert.equal(options.method, 'GET')
    return new Response('file-content', { status: 200 })
  })

  const file = await client.downloadFile('f')
  assert.equal(file.filePath, 'docs/a.txt')
  assert.equal(file.bytes.toString(), 'file-content')
  assert.match(calls[1].url, /\/file\/bot123456:telegram-secret-token\/docs\/a\.txt$/)

  const failing = clientWith((url) => {
    if (url.endsWith('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'docs/a.txt' } })
    throw new Error(`download failed ${url}`)
  }).client
  await assert.rejects(failing.downloadFile('f'), error => {
    assert.doesNotMatch(error.message, /telegram-secret-token/)
    assert.doesNotMatch(error.cause.message, /telegram-secret-token/)
    return true
  })
})

test('enforces Telegram file limits before and during download', async () => {
  const declared = clientWith((url) => {
    if (url.endsWith('/getFile')) {
      return jsonResponse({ ok: true, result: { file_path: 'docs/a.bin', file_size: 9 } })
    }
    throw new Error('download must not start')
  })
  await assert.rejects(declared.client.downloadFile('f', { maxBytes: 8 }), /declared size exceeds/u)
  assert.equal(declared.calls.length, 1)

  const streamed = clientWith((url) => {
    if (url.endsWith('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'docs/a.bin' } })
    return new Response(Buffer.from('123456789'), { status: 200 })
  })
  await assert.rejects(streamed.client.downloadFile('f', { maxBytes: 8 }), /download exceeds/u)
})
