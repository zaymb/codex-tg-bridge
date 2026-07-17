import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AttachmentStore } from '../src/attachment-store.mjs'
import {
  DEFAULT_RELAY_ATTACHMENT_BATCH_MAX_BYTES,
  DEFAULT_RELAY_ATTACHMENT_MAX_BYTES,
  prepareRelayAttachmentFrames,
  RelayAttachmentReceiver,
} from '../src/relay-attachment-transfer.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function remoteBatch(localPath, bytes) {
  return {
    batchId: 'batch:telegram:41:telegram:41',
    jobs: [{
      jobId: 'telegram:41',
      payload: {
        text: 'look at this',
        telegramContext: { updateId: '41', chatId: '42', messageId: '410' },
        attachments: [{
          kind: 'photo',
          fileId: 'photo-file-1',
          uniqueId: 'photo-unique-1',
          fileName: null,
          mimeType: 'image/jpeg',
          fileSize: bytes.length,
          width: 640,
          height: 480,
          durationSec: null,
          metadata: { variants: 3 },
          localPath,
          byteSize: bytes.length,
          sha256: sha256(bytes),
        }],
      },
    }],
  }
}

test('moves attachment bytes in bounded frames and materializes a verified local file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-attachment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.alloc(180_000, 0x5a)
  const remotePath = join(root, 'remote-photo.jpg')
  await writeFile(remotePath, bytes)
  const source = remoteBatch(remotePath, bytes)

  const prepared = await prepareRelayAttachmentFrames(source, { frameMaxBytes: 65_536 })

  assert.equal(prepared.frames[0].type, 'attachment_manifest')
  assert.equal(prepared.frames.filter(frame => frame.type === 'attachment_chunk').length > 1, true)
  assert.equal(prepared.frames.every(frame => Buffer.byteLength(JSON.stringify({ version: 1, ...frame })) <= 65_536), true)
  assert.equal('localPath' in prepared.batch.jobs[0].payload.attachments[0], false)
  assert.match(prepared.batch.jobs[0].payload.attachments[0].transferId, /^attachment-/)
  assert.equal(JSON.stringify(prepared.frames).includes(remotePath), false)

  const store = await AttachmentStore.open({ root: join(root, 'local') })
  const receiver = new RelayAttachmentReceiver({ attachmentStore: store })
  for (const frame of prepared.frames) await receiver.handleFrame({ version: 1, ...frame })
  const local = receiver.materializeBatch(prepared.batch)
  const attachment = local.jobs[0].payload.attachments[0]

  assert.deepEqual(await readFile(attachment.localPath), bytes)
  assert.equal(attachment.sha256, sha256(bytes))
  assert.equal(attachment.byteSize, bytes.length)
  assert.equal(JSON.stringify(local).includes(bytes.toString('base64').slice(0, 100)), false)
})

test('rejects corrupted and oversized relay attachments before materialization', async () => {
  const saved = []
  const receiver = new RelayAttachmentReceiver({
    attachmentStore: { async save(value) { saved.push(value); return { localPath: '/unused' } } },
    maxAttachmentBytes: 8,
  })
  const manifest = {
    version: 1,
    type: 'attachment_manifest',
    batchId: 'batch-a',
    jobId: 'job-a',
    transferId: 'attachment-12345678',
    updateId: '1',
    attachment: {
      kind: 'document',
      fileId: 'file-a',
      fileName: 'a.txt',
      byteSize: 3,
      sha256: sha256(Buffer.from('abc')),
    },
    chunkCount: 1,
  }
  await receiver.handleFrame(manifest)
  await assert.rejects(
    receiver.handleFrame({
      version: 1,
      type: 'attachment_chunk',
      batchId: 'batch-a',
      transferId: 'attachment-12345678',
      index: 0,
      data: Buffer.from('abd').toString('base64'),
    }),
    /hash mismatch/,
  )
  assert.equal(saved.length, 0)

  await assert.rejects(receiver.handleFrame({
    ...manifest,
    transferId: 'attachment-oversized',
    attachment: { ...manifest.attachment, byteSize: 9 },
  }), /exceeds maximum/)
})

test('rejects attachment metadata changed after the verified manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-attachment-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('verified-photo')
  const remotePath = join(root, 'remote-photo.jpg')
  await writeFile(remotePath, bytes)
  const prepared = await prepareRelayAttachmentFrames(remoteBatch(remotePath, bytes))
  const store = await AttachmentStore.open({ root: join(root, 'local') })
  const receiver = new RelayAttachmentReceiver({ attachmentStore: store })
  for (const frame of prepared.frames) await receiver.handleFrame({ version: 1, ...frame })
  prepared.batch.jobs[0].payload.attachments[0].kind = 'document'

  assert.throws(() => receiver.materializeBatch(prepared.batch), /identity mismatch/)
})

test('uses the Telegram Bot API download ceiling as the default relay limit', () => {
  assert.equal(DEFAULT_RELAY_ATTACHMENT_MAX_BYTES, 20_000_000)
  assert.equal(DEFAULT_RELAY_ATTACHMENT_BATCH_MAX_BYTES, DEFAULT_RELAY_ATTACHMENT_MAX_BYTES)
})

test('rejects an oversized aggregate batch before reading attachment bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-attachment-batch-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstPath = join(root, 'first.bin')
  const secondPath = join(root, 'second.bin')
  await writeFile(firstPath, Buffer.alloc(5, 1))
  await writeFile(secondPath, Buffer.alloc(5, 2))
  const batch = remoteBatch(firstPath, Buffer.alloc(5, 1))
  batch.jobs[0].payload.attachments.push({
    ...batch.jobs[0].payload.attachments[0],
    fileId: 'file-2',
    localPath: secondPath,
    byteSize: 5,
    sha256: sha256(Buffer.alloc(5, 2)),
  })
  let reads = 0

  await assert.rejects(prepareRelayAttachmentFrames(batch, {
    maxBatchBytes: 8,
    readFileImpl: async path => {
      reads += 1
      return readFile(path)
    },
  }), /batch exceeds maximum size/)
  assert.equal(reads, 0)
})

test('enforces the aggregate batch limit on the receiver', async () => {
  const receiver = new RelayAttachmentReceiver({
    attachmentStore: { async save() { return { localPath: '/unused' } } },
    maxAttachmentBytes: 8,
    maxBatchBytes: 8,
  })
  const attachment = {
    kind: 'document',
    fileId: 'file-a',
    byteSize: 5,
    sha256: sha256(Buffer.alloc(5)),
  }
  await receiver.handleFrame({
    version: 1,
    type: 'attachment_manifest',
    batchId: 'batch-a',
    jobId: 'job-a',
    transferId: 'attachment-one',
    updateId: '1',
    attachment,
    chunkCount: 1,
  })
  await assert.rejects(receiver.handleFrame({
    version: 1,
    type: 'attachment_manifest',
    batchId: 'batch-a',
    jobId: 'job-a',
    transferId: 'attachment-two',
    updateId: '1',
    attachment: { ...attachment, fileId: 'file-b' },
    chunkCount: 1,
  }), /batch exceeds maximum size/)
})
