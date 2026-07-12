import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationKey, normalizeUpdate } from '../src/update-normalizer.mjs'

test('normalizes a forum text message with sender, reply, quote, and entities', () => {
  const update = normalizeUpdate({
    update_id: 101,
    message: {
      message_id: 55,
      message_thread_id: 7,
      date: 1_720_000_000,
      chat: { id: -1001234567890, type: 'supergroup', title: 'Sandbox', is_forum: true },
      from: { id: 9007199254740991, is_bot: false, first_name: 'Alta', username: 'alta' },
      text: 'hello @bridge',
      entities: [{ type: 'mention', offset: 6, length: 7 }],
      quote: { text: 'prior words', position: 2, is_manual: true },
      reply_to_message: {
        message_id: 54,
        from: { id: 42, is_bot: true, first_name: 'Bridge' },
        text: 'previous answer',
      },
    },
  })

  assert.equal(update.updateId, '101')
  assert.equal(update.type, 'message')
  assert.equal(update.conversationKey, '-1001234567890:7')
  assert.equal(update.chat.id, '-1001234567890')
  assert.equal(update.actor.id, '9007199254740991')
  assert.equal(update.actor.displayName, 'Alta')
  assert.equal(update.message.id, '55')
  assert.equal(update.message.dateMs, 1_720_000_000_000)
  assert.equal(update.message.text, 'hello @bridge')
  assert.deepEqual(update.message.entities, [{ type: 'mention', offset: 6, length: 7 }])
  assert.deepEqual(update.message.quote, { text: 'prior words', position: 2, isManual: true })
  assert.deepEqual(update.message.replyTo, {
    messageId: '54',
    actor: { id: '42', isBot: true, username: null, displayName: 'Bridge' },
    text: 'previous answer',
    caption: null,
  })
})

test('normalizes edited channel captions and the largest photo variant', () => {
  const update = normalizeUpdate({
    update_id: 102,
    edited_channel_post: {
      message_id: 9,
      date: 1_720_000_000,
      edit_date: 1_720_000_100,
      chat: { id: -1007777777777, type: 'channel', title: 'Updates' },
      sender_chat: { id: -1007777777777, type: 'channel', title: 'Updates' },
      caption: 'new caption',
      caption_entities: [{ type: 'bold', offset: 0, length: 3 }],
      photo: [
        { file_id: 'small', file_unique_id: 'u-small', width: 90, height: 90, file_size: 100 },
        { file_id: 'large', file_unique_id: 'u-large', width: 1280, height: 720, file_size: 5000 },
      ],
    },
  })

  assert.equal(update.type, 'edited_channel_post')
  assert.equal(update.conversationKey, '-1007777777777')
  assert.equal(update.actor.id, '-1007777777777')
  assert.equal(update.actor.isBot, false)
  assert.equal(update.message.editDateMs, 1_720_000_100_000)
  assert.equal(update.message.caption, 'new caption')
  assert.deepEqual(update.message.entities, [{ type: 'bold', offset: 0, length: 3 }])
  assert.deepEqual(update.message.attachments, [{
    kind: 'photo',
    fileId: 'large',
    uniqueId: 'u-large',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 5000,
    width: 1280,
    height: 720,
    durationSec: null,
    metadata: { variants: 2 },
  }])
})

test('normalizes Telegram animated dice results', () => {
  const update = normalizeUpdate({
    update_id: 109,
    message: {
      message_id: 61,
      date: 1,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Alta' },
      dice: { emoji: '🎲', value: 6 },
    },
  })

  assert.deepEqual(update.message.dice, { emoji: '🎲', value: 6 })
  assert.equal(update.message.text, null)
})

test('normalizes every downloadable Telegram attachment class', () => {
  const base = {
    update_id: 103,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      document: { file_id: 'doc', file_unique_id: 'u-doc', file_name: 'a.pdf', mime_type: 'application/pdf', file_size: 10 },
      voice: { file_id: 'voice', file_unique_id: 'u-voice', mime_type: 'audio/ogg', file_size: 11, duration: 2 },
      audio: { file_id: 'audio', file_unique_id: 'u-audio', file_name: 'a.mp3', mime_type: 'audio/mpeg', file_size: 12, duration: 3, performer: 'P', title: 'T' },
      video: { file_id: 'video', file_unique_id: 'u-video', file_name: 'v.mp4', mime_type: 'video/mp4', file_size: 13, duration: 4, width: 640, height: 360 },
      animation: { file_id: 'gif', file_unique_id: 'u-gif', file_name: 'a.gif', mime_type: 'video/mp4', file_size: 14, duration: 5, width: 320, height: 240 },
      video_note: { file_id: 'note', file_unique_id: 'u-note', file_size: 15, duration: 6, length: 240 },
      sticker: { file_id: 'sticker', file_unique_id: 'u-sticker', file_size: 16, width: 512, height: 512, emoji: '🙂', set_name: 'set', is_animated: false, is_video: false },
    },
  }

  const attachments = normalizeUpdate(base).message.attachments
  assert.deepEqual(attachments.map(item => item.kind), [
    'document', 'voice', 'audio', 'video', 'animation', 'video_note', 'sticker',
  ])
  assert.equal(attachments[0].fileName, 'a.pdf')
  assert.deepEqual(attachments[2].metadata, { performer: 'P', title: 'T' })
  assert.equal(attachments[5].width, 240)
  assert.deepEqual(attachments[6].metadata, {
    emoji: '🙂',
    setName: 'set',
    isAnimated: false,
    isVideo: false,
  })
})

test('normalizes user reaction changes and anonymous reaction counts', () => {
  const userReaction = normalizeUpdate({
    update_id: 104,
    message_reaction: {
      chat: { id: -100123, type: 'supergroup', title: 'Sandbox' },
      message_id: 77,
      date: 1_720_000_000,
      user: { id: 42, is_bot: false, first_name: 'Alta' },
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    },
  })
  assert.equal(userReaction.type, 'message_reaction')
  assert.equal(userReaction.conversationKey, '-100123')
  assert.equal(userReaction.reaction.messageId, '77')
  assert.equal(userReaction.reaction.actor.id, '42')
  assert.deepEqual(userReaction.reaction.added, [{ type: 'emoji', emoji: '👍' }])

  const counts = normalizeUpdate({
    update_id: 105,
    message_reaction_count: {
      chat: { id: -100123, type: 'supergroup' },
      message_id: 77,
      date: 1_720_000_010,
      reactions: [{ type: { type: 'emoji', emoji: '👍' }, total_count: 3 }],
    },
  })
  assert.equal(counts.type, 'message_reaction_count')
  assert.deepEqual(counts.reaction.counts, [{ reaction: { type: 'emoji', emoji: '👍' }, count: 3 }])
  assert.equal(counts.reaction.actor, null)
})

test('normalizes callback queries using the callback message topic', () => {
  const update = normalizeUpdate({
    update_id: 106,
    callback_query: {
      id: 'callback-1',
      from: { id: 42, is_bot: false, first_name: 'Alta' },
      data: 'ap:opaque',
      message: {
        message_id: 88,
        message_thread_id: 7,
        date: 1,
        chat: { id: -100123, type: 'supergroup', is_forum: true },
      },
    },
  })

  assert.equal(update.type, 'callback_query')
  assert.equal(update.conversationKey, '-100123:7')
  assert.deepEqual(update.callback, {
    id: 'callback-1',
    data: 'ap:opaque',
    actor: { id: '42', isBot: false, username: null, displayName: 'Alta' },
    messageId: '88',
    inlineMessageId: null,
  })
})

test('normalizes membership updates and keeps unknown updates storable', () => {
  const membership = normalizeUpdate({
    update_id: 107,
    my_chat_member: {
      chat: { id: -100123, type: 'supergroup', title: 'Sandbox' },
      from: { id: 42, is_bot: false, first_name: 'Alta' },
      date: 1,
      old_chat_member: { status: 'left', user: { id: 99, is_bot: true, first_name: 'Bridge' } },
      new_chat_member: { status: 'member', user: { id: 99, is_bot: true, first_name: 'Bridge' } },
    },
  })
  assert.equal(membership.type, 'my_chat_member')
  assert.equal(membership.conversationKey, '-100123')
  assert.equal(membership.membership.oldStatus, 'left')
  assert.equal(membership.membership.newStatus, 'member')

  const unknown = normalizeUpdate({ update_id: 108, business_connection: { id: 'new-surface' } })
  assert.deepEqual(unknown, {
    updateId: '108',
    type: 'unknown',
    conversationKey: null,
    chat: null,
    actor: null,
    message: null,
    reaction: null,
    callback: null,
    membership: null,
    rawType: 'business_connection',
  })
})

test('conversationKey rejects missing chats and appends only valid topic IDs', () => {
  assert.equal(conversationKey({ id: '-100123' }, null), '-100123')
  assert.equal(conversationKey({ id: '-100123' }, '7'), '-100123:7')
  assert.throws(() => conversationKey(null, null), /chat id is required/)
  assert.throws(() => conversationKey({ id: '-100123' }, 'bad:topic'), /invalid message thread id/)
})
