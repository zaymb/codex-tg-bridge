import assert from 'node:assert/strict'
import test from 'node:test'

import { listKnownTopics, resolveTopicName, resolveTopicThreadId } from '../src/topic-map.mjs'

const topics = new Map([
  ['-100123', 'lobby'],
  ['-100123:7', 'support'],
  ['-100123:9', 'planning'],
])

test('resolves configured topic IDs to display names', () => {
  assert.equal(resolveTopicName(topics, '-100123'), 'lobby')
  assert.equal(resolveTopicName(topics, '-100123', '7'), 'support')
  assert.equal(resolveTopicName(topics, '-100123', '9'), 'planning')
  assert.equal(resolveTopicName(topics, '-100123', '9999'), undefined)
})

test('resolves configured display names back to routing IDs', () => {
  assert.equal(resolveTopicThreadId(topics, '-100123', 'lobby'), null)
  assert.equal(resolveTopicThreadId(topics, '-100123', 'support'), '7')
  assert.equal(resolveTopicThreadId(topics, '-100123', 'planning'), '9')
})

test('fails closed for unknown outbound topic names', () => {
  assert.throws(() => resolveTopicThreadId(topics, '-100123', 'missing'), /unknown or ambiguous topic/u)
  assert.throws(() => resolveTopicThreadId(topics, '-100999', 'support'), /unknown or ambiguous topic/u)
})

test('returns topic records without exposing mutable configuration', () => {
  const listed = listKnownTopics(topics, '-100123')
  assert.deepEqual(listed, [
    { threadId: null, name: 'lobby' },
    { threadId: '7', name: 'support' },
    { threadId: '9', name: 'planning' },
  ])
  listed[0].name = 'changed'
  assert.equal(resolveTopicName(topics, '-100123'), 'lobby')
})
