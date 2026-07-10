import assert from 'node:assert/strict'
import test from 'node:test'

import { splitTelegramText } from '../src/message-format.mjs'

test('keeps a normal conversational answer in one bubble', () => {
  const text = '第一段。\n\n第二段。\n\n第三段。'
  assert.deepEqual(splitTelegramText(text, 4096), [text])
})

test('normalizes CRLF and prefers paragraph boundaries under the hard limit', () => {
  const text = `${'a'.repeat(22)}\r\n\r\n${'b'.repeat(22)}\r\n\r\n${'c'.repeat(22)}`
  const chunks = splitTelegramText(text, 32)

  assert.deepEqual(chunks, ['a'.repeat(22), 'b'.repeat(22), 'c'.repeat(22)])
  assert.ok(chunks.every(chunk => chunk.length <= 32))
})

test('never splits a Unicode surrogate pair', () => {
  const text = '🙂'.repeat(24)
  const chunks = splitTelegramText(text, 33)

  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every(chunk => chunk.length <= 33))
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)))
  assert.ok(chunks.every(chunk => !/^[\uDC00-\uDFFF]/.test(chunk)))
})

test('closes and reopens a long fenced code block in every chunk', () => {
  const lines = Array.from({ length: 18 }, (_, index) => `console.log(${index});`)
  const text = `Before\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\n\nAfter`
  const chunks = splitTelegramText(text, 90)

  assert.ok(chunks.length > 3)
  assert.ok(chunks.every(chunk => chunk.length <= 90))
  const codeChunks = chunks.filter(chunk => chunk.startsWith('```js\n'))
  assert.ok(codeChunks.length > 1)
  assert.ok(codeChunks.every(chunk => chunk.endsWith('\n```')))
  const restoredLines = codeChunks.flatMap(chunk => chunk.slice(6, -4).split('\n')).filter(Boolean)
  assert.deepEqual(restoredLines, lines)
  assert.equal(chunks[0], 'Before')
  assert.equal(chunks.at(-1), 'After')
})

test('splits an overlong unbroken word without data loss', () => {
  const text = 'x'.repeat(101)
  const chunks = splitTelegramText(text, 32)

  assert.equal(chunks.join(''), text)
  assert.deepEqual(chunks.map(chunk => chunk.length), [32, 32, 32, 5])
})

test('rejects unusable limits and returns no empty bubbles', () => {
  assert.throws(() => splitTelegramText('hello', 10), /limit must be at least 32/)
  assert.deepEqual(splitTelegramText(' \n\n ', 4096), [])
})
