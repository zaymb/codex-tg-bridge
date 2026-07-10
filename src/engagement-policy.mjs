function result(action, reason, extendsSilence = false) {
  return { action, reason, extendsSilence }
}

function isCommand(update) {
  const text = update.message?.text ?? update.message?.caption ?? ''
  if (/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/u.test(text)) return true
  return (update.message?.entities ?? []).some(entity => entity.type === 'bot_command' && entity.offset === 0)
}

function isDirectMention(update, botUserId, botUsername) {
  const text = update.message?.text ?? update.message?.caption ?? ''
  for (const entity of update.message?.entities ?? []) {
    if (entity.type === 'text_mention' && String(entity.user?.id) === botUserId) return true
    if (entity.type !== 'mention' || !botUsername) continue
    const mentioned = text.slice(entity.offset, entity.offset + entity.length).toLowerCase()
    if (mentioned === `@${botUsername.toLowerCase()}`) return true
  }
  return false
}

function isReplyToBot(update, botUserId) {
  return Boolean(botUserId && update.message?.replyTo?.actor?.id === botUserId)
}

export class EngagementPolicy {
  #config
  #botUserId
  #botUsername
  #groupGate

  constructor(config, { botUserId = null, botUsername = null, groupGate = null } = {}) {
    this.#config = config
    this.#botUserId = botUserId === null ? null : String(botUserId)
    this.#botUsername = botUsername?.replace(/^@/u, '') ?? null
    this.#groupGate = groupGate
  }

  evaluate(update, { isKnownBotMessage = false } = {}) {
    if (!update || update.type === 'unknown') return result('store', 'unsupported_update')
    const chat = update.chat
    const actor = update.actor
    if (!chat?.id) return result('store', 'unsupported_update')

    if (chat.type === 'private') {
      const ownerDm = chat.id === this.#config.ownerUserId && actor?.id === this.#config.ownerUserId
      if (!ownerDm) return result('reject', 'unapproved_dm')
      if (update.type === 'callback_query') return result('callback', 'owner_callback')
      return result('turn', 'owner_dm', true)
    }

    if (chat.type === 'channel') {
      if (!this.#config.allowedChannelIds.has(chat.id)) return result('reject', 'unapproved_channel')
    } else if (!this.#config.allowedChatIds.has(chat.id)) {
      return result('reject', 'unapproved_group')
    }

    if (update.type === 'callback_query') return result('reject', 'group_callback_not_allowed')
    if (['my_chat_member', 'chat_member', 'chat_join_request'].includes(update.type)) {
      return result('store', 'membership_context')
    }

    if (update.type === 'message_reaction') {
      if (isKnownBotMessage && update.reaction?.actor?.id && update.reaction.actor.isBot !== true) {
        return result('turn', 'reaction_to_bot_message', true)
      }
      return result('store', 'reaction_context')
    }
    if (update.type === 'message_reaction_count') return result('store', 'anonymous_reaction_context')
    if (!update.message) return result('store', 'unsupported_update')

    const humanAuthored = actor?.isBot !== true && chat.type !== 'channel'
    if (isCommand(update)) return result('turn', 'command', humanAuthored)
    if (isDirectMention(update, this.#botUserId, this.#botUsername)) {
      return result('turn', 'direct_mention', humanAuthored)
    }
    if (isReplyToBot(update, this.#botUserId)) return result('turn', 'reply_to_bot', humanAuthored)

    if (humanAuthored && this.#groupGate) {
      const gate = this.#groupGate.evaluate(update)
      if (gate?.deliver) return result('turn', gate.reason || 'configured_group_gate', true)
    }
    if (!humanAuthored) return result('store', 'bot_authored_context')
    return result('store', 'ordinary_group_context', true)
  }
}
