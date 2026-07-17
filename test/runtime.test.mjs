import assert from 'node:assert/strict'
import test from 'node:test'

import { seedApprovedChats } from '../src/runtime.mjs'
import { StateStore } from '../src/state-store.mjs'

test('seeds owner, groups, channels, and forum aliases into the durable chat ledger', t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  const config = {
    ownerUserId: '42',
    allowedChatIds: new Set(['-100123', '-100456']),
    allowedChannelIds: new Set(['-100777']),
    chatAliases: new Map([
      ['sandbox', '-100123'],
      ['sandbox-topic', '-100123:7'],
      ['announcements', '-100777'],
    ]),
    topicNames: new Map([['-100123:7', 'Support']]),
  }

  seedApprovedChats(state, config, 100)
  seedApprovedChats(state, config, 200)

  assert.deepEqual(state.getApprovedChatByAlias('owner'), {
    conversationKey: '42',
    telegramChatId: '42',
    alias: 'owner',
    title: 'Owner DM',
    kind: 'private',
    updatedAtMs: 200,
  })
  assert.equal(state.getApprovedChatByAlias('sandbox').kind, 'group')
  assert.equal(state.getApprovedChatByAlias('sandbox-topic').kind, 'forum_topic')
  assert.equal(state.getApprovedChatByAlias('sandbox-topic').telegramChatId, '-100123')
  assert.equal(state.getApprovedChatByAlias('announcements').kind, 'channel')
  assert.equal(state.getApprovedChat('-100456').alias, null)
  assert.equal(state.listApprovedChats().length, 5)
})

test('replaces the approved chat ledger so removed chats and moved aliases are revoked', t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  const first = {
    ownerUserId: '42',
    allowedChatIds: new Set(['-1001', '-1002']),
    allowedChannelIds: new Set(),
    chatAliases: new Map([['sandbox', '-1001']]),
    topicNames: new Map(),
  }
  const second = {
    ownerUserId: '42',
    allowedChatIds: new Set(['-1002']),
    allowedChannelIds: new Set(),
    chatAliases: new Map([['sandbox', '-1002']]),
    topicNames: new Map(),
  }

  seedApprovedChats(state, first, 100)
  seedApprovedChats(state, second, 200)

  assert.equal(state.getApprovedChat('-1001'), null)
  assert.equal(state.getApprovedChatByAlias('sandbox').conversationKey, '-1002')
  assert.deepEqual(state.listApprovedChats().map(chat => chat.conversationKey), ['42', '-1002'])
})

test('seeds configured forum topic names for an approved group', t => {
  const state = StateStore.open(':memory:')
  t.after(() => state.close())
  seedApprovedChats(state, {
    ownerUserId: '42',
    allowedChatIds: new Set(['-100123']),
    allowedChannelIds: new Set(),
    chatAliases: new Map(),
    topicNames: new Map([
      ['-100123:7', 'Support'],
      ['-100123:9', 'Planning'],
    ]),
  }, 100)

  assert.equal(state.getApprovedChat('-100123:7').title, 'Support')
  assert.equal(state.getApprovedChat('-100123:9').title, 'Planning')
})
