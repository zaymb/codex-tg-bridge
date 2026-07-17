function conversationKey(chatId, threadId = null) {
  return threadId === null || threadId === undefined
    ? String(chatId)
    : `${chatId}:${threadId}`
}

export function resolveTopicName(topicNames, chatId, threadId = null) {
  return topicNames?.get(conversationKey(chatId, threadId))
}

export function resolveTopicThreadId(topicNames, chatId, name) {
  const normalizedChatId = String(chatId)
  const normalizedName = String(name).trim()
  const matches = [...(topicNames ?? new Map())]
    .filter(([key, value]) => (key === normalizedChatId || key.startsWith(`${normalizedChatId}:`))
      && value === normalizedName)
  if (matches.length !== 1) throw new Error(`unknown or ambiguous topic name: ${name}`)
  const separator = matches[0][0].indexOf(':')
  return separator === -1 ? null : matches[0][0].slice(separator + 1)
}

export function listKnownTopics(topicNames, chatId) {
  const normalizedChatId = String(chatId)
  return [...(topicNames ?? new Map())]
    .filter(([key]) => key === normalizedChatId || key.startsWith(`${normalizedChatId}:`))
    .map(([key, name]) => {
      const separator = key.indexOf(':')
      return {
        threadId: separator === -1 ? null : key.slice(separator + 1),
        name,
      }
    })
}
