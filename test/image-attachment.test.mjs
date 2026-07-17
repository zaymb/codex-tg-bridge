import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyImageAttachment } from '../src/image-attachment.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary')
const GIF = Buffer.from('GIF89a', 'ascii')

test('classifies Telegram photos and supported image documents by content', () => {
  assert.deepEqual(classifyImageAttachment({ kind: 'photo', mimeType: 'image/jpeg' }, JPEG), {
    codexInput: 'localImage',
    detectedMimeType: 'image/jpeg',
  })
  assert.deepEqual(classifyImageAttachment({
    kind: 'document',
    fileName: 'diagram.png',
    mimeType: 'application/octet-stream',
  }, PNG), {
    codexInput: 'localImage',
    detectedMimeType: 'image/png',
  })
  assert.equal(classifyImageAttachment({
    kind: 'document',
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
  }, PNG), null)
  assert.equal(classifyImageAttachment({ kind: 'document', fileName: 'clip.webp' }, WEBP)?.detectedMimeType, 'image/webp')
  assert.equal(classifyImageAttachment({ kind: 'document', fileName: 'clip.gif' }, GIF)?.detectedMimeType, 'image/gif')
})

test('rejects image candidates with invalid or contradictory content', () => {
  assert.throws(
    () => classifyImageAttachment({ kind: 'photo', mimeType: 'image/jpeg' }, Buffer.from('not-image')),
    /not a supported image/u,
  )
  assert.throws(
    () => classifyImageAttachment({ kind: 'document', fileName: 'wrong.png', mimeType: 'image/png' }, JPEG),
    /metadata did not match/u,
  )
})
