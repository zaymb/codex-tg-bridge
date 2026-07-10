const MESSAGE_FIELDS = ['message', 'edited_message', 'channel_post', 'edited_channel_post']
const MEMBERSHIP_FIELDS = ['my_chat_member', 'chat_member', 'chat_join_request']

function id(value) {
  return value === null || value === undefined ? null : String(value)
}

function displayName(value) {
  if (!value) return null
  if (value.title) return value.title
  const name = [value.first_name, value.last_name].filter(Boolean).join(' ').trim()
  return name || value.username || null
}

function normalizeActor(value) {
  if (!value) return null
  return {
    id: id(value.id),
    isBot: value.is_bot === true,
    username: value.username ?? null,
    displayName: displayName(value),
  }
}

function normalizeChat(value) {
  if (!value) return null
  return {
    id: id(value.id),
    type: value.type ?? null,
    title: value.title ?? null,
    username: value.username ?? null,
    isForum: value.is_forum === true,
  }
}

function optionalMetadata(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined))
}

function attachment(kind, value, overrides = {}) {
  return {
    kind,
    fileId: value.file_id,
    uniqueId: value.file_unique_id ?? null,
    fileName: value.file_name ?? null,
    mimeType: value.mime_type ?? null,
    fileSize: value.file_size ?? null,
    width: value.width ?? null,
    height: value.height ?? null,
    durationSec: value.duration ?? null,
    metadata: {},
    ...overrides,
  }
}

function normalizeAttachments(message) {
  const result = []
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = [...message.photo].sort((left, right) => {
      const leftArea = (left.width ?? 0) * (left.height ?? 0)
      const rightArea = (right.width ?? 0) * (right.height ?? 0)
      return rightArea - leftArea || (right.file_size ?? 0) - (left.file_size ?? 0)
    })[0]
    result.push(attachment('photo', largest, {
      fileName: null,
      mimeType: 'image/jpeg',
      metadata: { variants: message.photo.length },
    }))
  }
  if (message.document) result.push(attachment('document', message.document))
  if (message.voice) result.push(attachment('voice', message.voice, { fileName: null }))
  if (message.audio) {
    result.push(attachment('audio', message.audio, {
      metadata: optionalMetadata([
        ['performer', message.audio.performer],
        ['title', message.audio.title],
      ]),
    }))
  }
  if (message.video) result.push(attachment('video', message.video))
  if (message.animation) result.push(attachment('animation', message.animation))
  if (message.video_note) {
    result.push(attachment('video_note', message.video_note, {
      fileName: null,
      mimeType: 'video/mp4',
      width: message.video_note.length ?? null,
      height: message.video_note.length ?? null,
    }))
  }
  if (message.sticker) {
    const mimeType = message.sticker.is_animated
      ? 'application/x-tgsticker'
      : message.sticker.is_video ? 'video/webm' : 'image/webp'
    result.push(attachment('sticker', message.sticker, {
      fileName: null,
      mimeType,
      durationSec: null,
      metadata: {
        emoji: message.sticker.emoji ?? null,
        setName: message.sticker.set_name ?? null,
        isAnimated: message.sticker.is_animated === true,
        isVideo: message.sticker.is_video === true,
      },
    }))
  }
  return result
}

function normalizeReply(message) {
  const reply = message.reply_to_message
  if (!reply) return null
  return {
    messageId: id(reply.message_id),
    actor: normalizeActor(reply.from ?? reply.sender_chat),
    text: reply.text ?? null,
    caption: reply.caption ?? null,
  }
}

function normalizeQuote(quote) {
  if (!quote) return null
  return {
    text: quote.text,
    position: quote.position ?? null,
    isManual: quote.is_manual === true,
  }
}

function normalizeService(message) {
  const serviceFields = [
    'new_chat_members',
    'left_chat_member',
    'new_chat_title',
    'new_chat_photo',
    'delete_chat_photo',
    'group_chat_created',
    'supergroup_chat_created',
    'channel_chat_created',
    'message_auto_delete_timer_changed',
    'migrate_to_chat_id',
    'migrate_from_chat_id',
    'pinned_message',
    'forum_topic_created',
    'forum_topic_closed',
    'forum_topic_reopened',
  ]
  const entries = serviceFields.filter(field => message[field] !== undefined).map(field => [field, message[field]])
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

function normalizeMessage(message) {
  return {
    id: id(message.message_id),
    threadId: id(message.message_thread_id),
    dateMs: message.date === undefined ? null : message.date * 1_000,
    editDateMs: message.edit_date === undefined ? null : message.edit_date * 1_000,
    text: message.text ?? null,
    caption: message.caption ?? null,
    entities: message.entities ?? message.caption_entities ?? [],
    replyTo: normalizeReply(message),
    quote: normalizeQuote(message.quote),
    attachments: normalizeAttachments(message),
    service: normalizeService(message),
  }
}

function normalizeReactionType(reaction) {
  if (!reaction) return null
  if (reaction.type === 'emoji') return { type: 'emoji', emoji: reaction.emoji }
  if (reaction.type === 'custom_emoji') return { type: 'custom_emoji', customEmojiId: reaction.custom_emoji_id }
  if (reaction.type === 'paid') return { type: 'paid' }
  return { type: reaction.type ?? 'unknown' }
}

function reactionDifference(left, right) {
  const rightKeys = new Set(right.map(value => JSON.stringify(value)))
  return left.filter(value => !rightKeys.has(JSON.stringify(value)))
}

export function conversationKey(chat, messageThreadId = null) {
  if (!chat?.id) throw new Error('chat id is required for a conversation key')
  const chatId = String(chat.id)
  if (messageThreadId === null || messageThreadId === undefined) return chatId
  const threadId = String(messageThreadId)
  if (!/^\d+$/.test(threadId)) throw new Error('invalid message thread id')
  return `${chatId}:${threadId}`
}

function emptyResult(raw, type, chat = null, actor = null, key = null) {
  return {
    updateId: id(raw.update_id),
    type,
    conversationKey: key,
    chat,
    actor,
    message: null,
    reaction: null,
    callback: null,
    membership: null,
    rawType: type,
  }
}

export function normalizeUpdate(raw) {
  if (!raw || raw.update_id === undefined) throw new Error('Telegram update_id is required')

  for (const field of MESSAGE_FIELDS) {
    const value = raw[field]
    if (!value) continue
    const chat = normalizeChat(value.chat)
    const actor = normalizeActor(value.from ?? value.sender_chat)
    const message = normalizeMessage(value)
    const result = emptyResult(raw, field, chat, actor, conversationKey(chat, message.threadId))
    result.message = message
    return result
  }

  if (raw.message_reaction) {
    const value = raw.message_reaction
    const chat = normalizeChat(value.chat)
    const actor = normalizeActor(value.user ?? value.actor_chat)
    const oldReaction = (value.old_reaction ?? []).map(normalizeReactionType)
    const newReaction = (value.new_reaction ?? []).map(normalizeReactionType)
    const result = emptyResult(raw, 'message_reaction', chat, actor, conversationKey(chat))
    result.reaction = {
      messageId: id(value.message_id),
      dateMs: value.date === undefined ? null : value.date * 1_000,
      actor,
      old: oldReaction,
      current: newReaction,
      added: reactionDifference(newReaction, oldReaction),
      removed: reactionDifference(oldReaction, newReaction),
      counts: null,
    }
    return result
  }

  if (raw.message_reaction_count) {
    const value = raw.message_reaction_count
    const chat = normalizeChat(value.chat)
    const result = emptyResult(raw, 'message_reaction_count', chat, null, conversationKey(chat))
    result.reaction = {
      messageId: id(value.message_id),
      dateMs: value.date === undefined ? null : value.date * 1_000,
      actor: null,
      old: null,
      current: null,
      added: null,
      removed: null,
      counts: (value.reactions ?? []).map(item => ({
        reaction: normalizeReactionType(item.type),
        count: item.total_count,
      })),
    }
    return result
  }

  if (raw.callback_query) {
    const value = raw.callback_query
    const chat = normalizeChat(value.message?.chat)
    const actor = normalizeActor(value.from)
    const messageId = id(value.message?.message_id)
    const threadId = id(value.message?.message_thread_id)
    const key = chat ? conversationKey(chat, threadId) : null
    const result = emptyResult(raw, 'callback_query', chat, actor, key)
    result.callback = {
      id: value.id,
      data: value.data ?? null,
      actor,
      messageId,
      inlineMessageId: value.inline_message_id ?? null,
    }
    return result
  }

  for (const field of MEMBERSHIP_FIELDS) {
    const value = raw[field]
    if (!value) continue
    const chat = normalizeChat(value.chat)
    const actor = normalizeActor(value.from ?? value.user)
    const result = emptyResult(raw, field, chat, actor, conversationKey(chat))
    result.membership = {
      dateMs: value.date === undefined ? null : value.date * 1_000,
      oldStatus: value.old_chat_member?.status ?? null,
      newStatus: value.new_chat_member?.status ?? null,
      member: normalizeActor(value.new_chat_member?.user ?? value.user),
      inviteLink: value.invite_link ?? null,
    }
    return result
  }

  const rawType = Object.keys(raw).find(key => key !== 'update_id') ?? 'unknown'
  return {
    updateId: id(raw.update_id),
    type: 'unknown',
    conversationKey: null,
    chat: null,
    actor: null,
    message: null,
    reaction: null,
    callback: null,
    membership: null,
    rawType,
  }
}
