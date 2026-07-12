import assert from 'node:assert/strict'
import test from 'node:test'

import { EngagementPolicy } from '../src/engagement-policy.mjs'

function config() {
  return {
    ownerUserId: '42',
    allowedChatIds: new Set(['-100123']),
    allowedChannelIds: new Set(['-100777']),
  }
}

function message(overrides = {}) {
  return {
    type: 'message',
    conversationKey: '-100123',
    chat: { id: '-100123', type: 'supergroup' },
    actor: { id: '99', isBot: false, username: 'human', displayName: 'Human' },
    message: {
      id: '10',
      threadId: null,
      text: 'ordinary message',
      caption: null,
      entities: [],
      replyTo: null,
      attachments: [],
    },
    reaction: null,
    callback: null,
    ...overrides,
  }
}

test('always starts a turn for the owner private chat and rejects other DMs', () => {
  const policy = new EngagementPolicy(config())
  const owner = message({
    conversationKey: '42',
    chat: { id: '42', type: 'private' },
    actor: { id: '42', isBot: false },
  })
  const stranger = message({
    conversationKey: '99',
    chat: { id: '99', type: 'private' },
    actor: { id: '99', isBot: false },
  })

  assert.deepEqual(policy.evaluate(owner), { action: 'turn', reason: 'owner_dm', extendsSilence: true })
  assert.deepEqual(policy.evaluate(stranger), { action: 'reject', reason: 'unapproved_dm', extendsSilence: false })
})

test('starts approved group turns for commands, direct mentions, and replies to the bot', () => {
  const policy = new EngagementPolicy(config(), { botUserId: '500', botUsername: 'bridge_bot' })
  const command = message({ message: { ...message().message, text: '/status' } })
  const mention = message({
    message: {
      ...message().message,
      text: 'hello @bridge_bot',
      entities: [{ type: 'mention', offset: 6, length: 11 }],
    },
  })
  const reply = message({
    message: {
      ...message().message,
      text: 'following up',
      replyTo: { messageId: '9', actor: { id: '500', isBot: true }, text: 'answer', caption: null },
    },
  })

  assert.equal(policy.evaluate(command).reason, 'command')
  assert.equal(policy.evaluate(mention).reason, 'direct_mention')
  assert.equal(policy.evaluate(reply).reason, 'reply_to_bot')
  assert.ok([command, mention, reply].every(update => policy.evaluate(update).action === 'turn'))
})

test('reserves /new and /stop in approved groups for the owner', () => {
  const policy = new EngagementPolicy(config())

  for (const command of ['/new', '/stop@bridge_bot']) {
    const outsider = message({ message: { ...message().message, text: command } })
    assert.deepEqual(policy.evaluate(outsider), {
      action: 'store',
      reason: 'owner_only_system_command',
      extendsSilence: true,
    })

    const owner = message({
      actor: { id: '42', isBot: false, username: 'owner', displayName: 'Owner' },
      message: { ...message().message, text: command },
    })
    assert.deepEqual(policy.evaluate(owner), {
      action: 'turn',
      reason: 'owner_system_command',
      extendsSilence: true,
    })
  }
})

test('stores ordinary approved group traffic and marks bot traffic as non-extending', () => {
  const policy = new EngagementPolicy(config(), { botUserId: '500', botUsername: 'bridge_bot' })
  const human = message()
  const bot = message({ actor: { id: '600', isBot: true, username: 'other_bot' } })

  assert.deepEqual(policy.evaluate(human), {
    action: 'store',
    reason: 'ordinary_group_context',
    extendsSilence: true,
  })
  assert.deepEqual(policy.evaluate(bot), {
    action: 'store',
    reason: 'bot_authored_context',
    extendsSilence: false,
  })
})

test('can explicitly deliver bot-authored group traffic without extending human silence', () => {
  const policy = new EngagementPolicy(
    { ...config(), deliverBotMessages: true },
    { botUserId: '500', botUsername: 'bridge_bot' },
  )
  const bot = message({ actor: { id: '600', isBot: true, username: 'other_bot' } })

  assert.deepEqual(policy.evaluate(bot), {
    action: 'turn',
    reason: 'configured_bot_passthrough',
    extendsSilence: false,
  })
})

test('lets an explicit production gate promote ordinary group traffic', () => {
  const gateCalls = []
  const groupGate = {
    evaluate(update) {
      gateCalls.push(update.message.id)
      return { deliver: true, reason: 'configured_gate' }
    },
  }
  const policy = new EngagementPolicy(config(), { groupGate })

  assert.deepEqual(policy.evaluate(message()), {
    action: 'turn',
    reason: 'configured_gate',
    extendsSilence: true,
  })
  assert.deepEqual(gateCalls, ['10'])
})

test('starts a reaction turn only for an identified actor on a known bot message', () => {
  const policy = new EngagementPolicy(config())
  const reaction = {
    type: 'message_reaction',
    conversationKey: '-100123',
    chat: { id: '-100123', type: 'supergroup' },
    actor: { id: '99', isBot: false },
    message: null,
    reaction: { messageId: '55', actor: { id: '99', isBot: false }, added: [{ type: 'emoji', emoji: '👍' }] },
    callback: null,
  }

  assert.deepEqual(policy.evaluate(reaction, { isKnownBotMessage: true }), {
    action: 'turn',
    reason: 'reaction_to_bot_message',
    extendsSilence: true,
  })
  assert.equal(policy.evaluate(reaction, { isKnownBotMessage: false }).action, 'store')
  const anonymous = { ...reaction, type: 'message_reaction_count', actor: null, reaction: { ...reaction.reaction, actor: null } }
  assert.equal(policy.evaluate(anonymous, { isKnownBotMessage: true }).action, 'store')
})

test('routes owner-DM approval callbacks without starting a Codex turn', () => {
  const policy = new EngagementPolicy(config())
  const update = {
    type: 'callback_query',
    conversationKey: '42',
    chat: { id: '42', type: 'private' },
    actor: { id: '42', isBot: false },
    callback: { id: 'callback-1', data: 'ap:opaque-token:approve' },
  }
  assert.deepEqual(policy.evaluate(update), {
    action: 'callback',
    reason: 'owner_callback',
    extendsSilence: false,
  })
})

test('allows only explicitly configured channels and groups', () => {
  const policy = new EngagementPolicy(config())
  const unknownGroup = message({ chat: { id: '-100999', type: 'supergroup' }, conversationKey: '-100999' })
  const approvedChannel = message({
    type: 'channel_post',
    chat: { id: '-100777', type: 'channel' },
    conversationKey: '-100777',
    actor: { id: '-100777', isBot: false },
  })
  const unknownChannel = { ...approvedChannel, chat: { id: '-100888', type: 'channel' }, conversationKey: '-100888' }

  assert.equal(policy.evaluate(unknownGroup).action, 'reject')
  assert.equal(policy.evaluate(approvedChannel).action, 'store')
  assert.equal(policy.evaluate(unknownChannel).action, 'reject')
})

test('stores unknown update types as unsupported instead of crashing', () => {
  const policy = new EngagementPolicy(config())
  assert.deepEqual(policy.evaluate({ type: 'unknown', chat: null, actor: null }), {
    action: 'store',
    reason: 'unsupported_update',
    extendsSilence: false,
  })
})
