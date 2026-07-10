const BOT_API_TOKEN = /(https:\/\/api\.telegram\.org\/bot)[^/\s]+/giu
const GENERIC_TELEGRAM_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/gu

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAllLiteral(value, needles, replacement) {
  let output = value
  const ordered = [...new Set(needles.filter(Boolean))].sort((a, b) => b.length - a.length)
  for (const needle of ordered) {
    output = output.replace(new RegExp(escapeRegExp(String(needle)), 'gu'), replacement)
  }
  return output
}

function redactString(value, secrets) {
  let output = value.replace(BOT_API_TOKEN, '$1[REDACTED]')
  output = output.replace(GENERIC_TELEGRAM_TOKEN, '[REDACTED]')
  output = replaceAllLiteral(output, secrets.credentials ?? [], '[REDACTED]')
  output = replaceAllLiteral(output, secrets.callbackTokens ?? [], '[REDACTED]')
  output = replaceAllLiteral(output, secrets.identifiers ?? [], '[ID]')
  return output
}

function redactValue(value, secrets, seen) {
  if (typeof value === 'string') return redactString(value, secrets)
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (value instanceof Error) return redactErrorInternal(value, secrets, seen)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets, seen))

  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = redactValue(item, secrets, seen)
  }
  return output
}

function redactErrorInternal(error, secrets, seen) {
  if (seen.has(error)) return new Error('[Circular error]')
  seen.add(error)

  const cause = error.cause === undefined ? undefined : redactValue(error.cause, secrets, seen)
  const output = new Error(redactString(error.message, secrets), cause === undefined ? undefined : { cause })
  output.name = error.name
  if (error.stack) output.stack = redactString(error.stack, secrets)
  for (const [key, value] of Object.entries(error)) {
    if (key === 'cause') continue
    output[key] = redactValue(value, secrets, seen)
  }
  return output
}

export function redact(value, secrets = {}) {
  return redactValue(value, secrets, new WeakSet())
}

export function redactError(error, secrets = {}) {
  if (!(error instanceof Error)) {
    throw new TypeError('redactError expects an Error')
  }
  return redactErrorInternal(error, secrets, new WeakSet())
}
