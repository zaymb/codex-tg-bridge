import { extname } from 'node:path'

const MIME_TO_EXTENSION = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

function normalizeMime(value) {
  const mime = String(value ?? '').trim().toLowerCase()
  return mime === 'image/jpg' ? 'image/jpeg' : mime || null
}

export function isSupportedImageMime(value) {
  return MIME_TO_EXTENSION.has(normalizeMime(value))
}

function isImageCandidate(attachment) {
  if (attachment?.kind === 'photo') return true
  if (attachment?.kind !== 'document') return false
  return isSupportedImageMime(attachment.mimeType)
    || IMAGE_EXTENSIONS.has(extname(String(attachment.fileName ?? '')).toLowerCase())
}

function detectImageMime(bytes) {
  const data = Buffer.from(bytes)
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) {
    return 'image/gif'
  }
  if (data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

export function classifyImageAttachment(attachment, bytes) {
  if (!isImageCandidate(attachment)) return null
  const detectedMimeType = detectImageMime(bytes)
  if (!detectedMimeType) throw new Error('Telegram image content is not a supported image')
  const claimedMimeType = normalizeMime(attachment.mimeType)
  if (isSupportedImageMime(claimedMimeType) && claimedMimeType !== detectedMimeType) {
    throw new Error('Telegram image metadata did not match its content')
  }
  return { codexInput: 'localImage', detectedMimeType }
}
