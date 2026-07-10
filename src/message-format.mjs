function safeSliceEnd(value, end) {
  let safeEnd = Math.min(end, value.length)
  if (safeEnd > 0 && safeEnd < value.length) {
    const previous = value.charCodeAt(safeEnd - 1)
    const next = value.charCodeAt(safeEnd)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      safeEnd -= 1
    }
  }
  return safeEnd
}

function splitPlain(value, limit) {
  const chunks = []
  let remaining = value
  while (remaining.length > limit) {
    let end = safeSliceEnd(remaining, limit)
    const window = remaining.slice(0, end)
    const preferred = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
    if (preferred >= Math.floor(limit / 2)) end = preferred + 1
    if (end === 0) end = safeSliceEnd(remaining, limit)
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function parseSegments(text) {
  const lines = text.split('\n')
  const segments = []
  let plain = []

  const flushPlain = () => {
    if (plain.length === 0) return
    const value = plain.join('\n')
    for (const paragraph of value.split(/\n{2,}/u)) {
      if (paragraph.trim()) segments.push({ type: 'plain', value: paragraph.trim() })
    }
    plain = []
  }

  for (let index = 0; index < lines.length;) {
    const opening = lines[index].match(/^```([^`]*)$/u)
    if (!opening) {
      plain.push(lines[index])
      index += 1
      continue
    }

    flushPlain()
    const language = opening[1].trim()
    const content = []
    index += 1
    while (index < lines.length && lines[index] !== '```') {
      content.push(lines[index])
      index += 1
    }
    if (index >= lines.length) {
      plain.push(`\`\`\`${language}`)
      plain.push(...content)
      break
    }
    index += 1
    segments.push({ type: 'code', language, value: content.join('\n') })
  }
  flushPlain()
  return segments
}

function splitCode(segment, limit) {
  const opening = `\`\`\`${segment.language}\n`
  const closing = '\n```'
  const contentLimit = limit - opening.length - closing.length
  if (contentLimit < 1) throw new Error('limit is too small for a fenced code block')
  const full = `${opening}${segment.value}${closing}`
  if (full.length <= limit) return [full]

  const pieces = []
  let current = ''
  for (const line of segment.value.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line
    if (candidate.length <= contentLimit) {
      current = candidate
      continue
    }
    if (current) pieces.push(current)
    const linePieces = splitPlain(line, contentLimit)
    pieces.push(...linePieces.slice(0, -1))
    current = linePieces.at(-1) ?? ''
  }
  if (current || pieces.length === 0) pieces.push(current)
  return pieces.map(piece => `${opening}${piece}${closing}`)
}

export function splitTelegramText(input, limit = 4096) {
  if (!Number.isInteger(limit) || limit < 32) throw new Error('limit must be at least 32')
  const text = String(input ?? '').replace(/\r\n?/gu, '\n').trim()
  if (!text) return []

  const output = []
  let pendingPlain = null
  const flushPlain = () => {
    if (pendingPlain !== null) output.push(pendingPlain)
    pendingPlain = null
  }

  for (const segment of parseSegments(text)) {
    if (segment.type === 'code') {
      flushPlain()
      output.push(...splitCode(segment, limit))
      continue
    }

    for (const piece of splitPlain(segment.value, limit)) {
      if (pendingPlain === null) {
        pendingPlain = piece
        continue
      }
      const combined = `${pendingPlain}\n\n${piece}`
      if (combined.length <= limit) pendingPlain = combined
      else {
        flushPlain()
        pendingPlain = piece
      }
    }
  }
  flushPlain()
  return output.filter(Boolean)
}
