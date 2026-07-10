import assert from 'node:assert/strict'
import test from 'node:test'

import { redact, redactError } from '../src/redact.mjs'

const secrets = {
  credentials: ['123456:telegram-secret'],
  callbackTokens: ['opaque-callback-token'],
  identifiers: ['9007199254740993123', '-1001234567890123456'],
}

test('redacts Telegram Bot API URLs and explicit credentials', () => {
  const input = 'POST https://api.telegram.org/bot123456:telegram-secret/sendMessage failed: 123456:telegram-secret'
  const output = redact(input, secrets)

  assert.equal(output, 'POST https://api.telegram.org/bot[REDACTED]/sendMessage failed: [REDACTED]')
})

test('redacts callback tokens and configured identifiers', () => {
  const input = 'callback=ap:opaque-callback-token owner=9007199254740993123 chat=-1001234567890123456'
  assert.equal(redact(input, secrets), 'callback=ap:[REDACTED] owner=[ID] chat=[ID]')
})

test('redacts nested values without mutating the source object', () => {
  const input = {
    url: 'https://api.telegram.org/bot123456:telegram-secret/getUpdates',
    nested: [{ callback: 'opaque-callback-token' }],
    count: 2,
  }
  const output = redact(input, secrets)

  assert.deepEqual(output, {
    url: 'https://api.telegram.org/bot[REDACTED]/getUpdates',
    nested: [{ callback: '[REDACTED]' }],
    count: 2,
  })
  assert.equal(input.nested[0].callback, 'opaque-callback-token')
})

test('redacts Error message, stack, cause, and enumerable metadata', () => {
  const cause = new Error('chat -1001234567890123456 rejected')
  const error = new Error('token 123456:telegram-secret failed', { cause })
  error.callback = 'opaque-callback-token'

  const output = redactError(error, secrets)

  assert.notEqual(output, error)
  assert.equal(output.message, 'token [REDACTED] failed')
  assert.match(output.stack, /token \[REDACTED\] failed/)
  assert.equal(output.cause.message, 'chat [ID] rejected')
  assert.equal(output.callback, '[REDACTED]')
})

test('leaves booleans, numbers, null, and undefined unchanged', () => {
  assert.equal(redact(true, secrets), true)
  assert.equal(redact(42, secrets), 42)
  assert.equal(redact(null, secrets), null)
  assert.equal(redact(undefined, secrets), undefined)
})
