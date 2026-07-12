export const TELEGRAM_DICE_EMOJIS = Object.freeze(['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'])

const ALLOWED = new Set(TELEGRAM_DICE_EMOJIS)

export function requireTelegramDiceEmoji(value) {
  if (!ALLOWED.has(value)) {
    throw new Error(`Telegram dice emoji must be one of: ${TELEGRAM_DICE_EMOJIS.join(' ')}`)
  }
  return value
}
