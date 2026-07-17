import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import { isSupportedImageMime } from './image-attachment.mjs'

export const DEFAULT_RELAY_ATTACHMENT_MAX_BYTES = 20_000_000
// A coalesced relay turn receives the same memory budget as one Bot API file.
export const DEFAULT_RELAY_ATTACHMENT_BATCH_MAX_BYTES = DEFAULT_RELAY_ATTACHMENT_MAX_BYTES

const TRANSFER_ID = /^[A-Za-z0-9:_-]{8,160}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const KIND = /^[a-z][a-z0-9_]{0,31}$/u

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}

function frameSize(frame) {
  return Buffer.byteLength(JSON.stringify({ version: 1, ...frame }))
}

function assertFrameSize(frame, frameMaxBytes) {
  if (frameSize(frame) > frameMaxBytes) throw new Error('relay attachment frame exceeds maximum size')
}

function transferIdFor(jobId, attachment, index, digest) {
  const hash = createHash('sha256')
    .update(`${jobId}\0${attachment.fileId}\0${index}\0${digest}`)
    .digest('hex')
    .slice(0, 32)
  return `attachment-${hash}`
}

function chunkByteLimit(frame, frameMaxBytes) {
  const overhead = frameSize({ ...frame, data: '' })
  const available = frameMaxBytes - overhead
  if (available < 8) throw new Error('relay frame limit is too small for attachment chunks')
  return Math.max(1, Math.floor(available * 3 / 4) - 3)
}

function wireAttachment(attachment, transferId, byteSize, digest) {
  const { localPath: _localPath, ...metadata } = attachment
  return {
    ...metadata,
    byteSize,
    sha256: digest,
    transferId,
  }
}

function attachmentIdentity(value) {
  return {
    kind: value.kind,
    fileId: value.fileId,
    uniqueId: value.uniqueId ?? null,
    fileName: value.fileName ?? null,
    mimeType: value.mimeType ?? null,
    fileSize: value.fileSize ?? null,
    width: value.width ?? null,
    height: value.height ?? null,
    durationSec: value.durationSec ?? null,
    metadata: value.metadata ?? {},
    codexInput: value.codexInput ?? null,
    detectedMimeType: value.detectedMimeType ?? null,
    byteSize: value.byteSize,
    sha256: value.sha256,
  }
}

export class RelayAttachmentPreparationError extends Error {
  constructor(message, { jobId, cause = null } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RelayAttachmentPreparationError'
    this.jobId = jobId
  }
}

function preparationError(error, jobId) {
  if (error instanceof RelayAttachmentPreparationError) return error
  return new RelayAttachmentPreparationError(error.message, { jobId, cause: error })
}

export async function prepareRelayAttachmentFrames(batch, {
  frameMaxBytes = 262_144,
  maxAttachmentBytes = DEFAULT_RELAY_ATTACHMENT_MAX_BYTES,
  maxBatchBytes = DEFAULT_RELAY_ATTACHMENT_BATCH_MAX_BYTES,
  readFileImpl = readFile,
  statImpl = stat,
} = {}) {
  if (!batch?.batchId || !Array.isArray(batch.jobs)) throw new Error('relay attachment batch is malformed')
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 0) {
    throw new Error('relay attachment batch limit is invalid')
  }
  const frames = []
  const jobs = []
  const sources = []
  let batchBytes = 0

  for (const job of batch.jobs) {
    const sourceAttachments = job.payload?.attachments ?? []
    for (let index = 0; index < sourceAttachments.length; index += 1) {
      const attachment = sourceAttachments[index]
      try {
        const localPath = requireString(attachment.localPath, 'relay attachment localPath')
        const metadata = await statImpl(localPath)
        if (!metadata.isFile()) throw new Error('relay attachment path is not a regular file')
        if (metadata.size > maxAttachmentBytes) throw new Error('relay attachment exceeds maximum size')
        if (attachment.byteSize !== undefined && attachment.byteSize !== null && attachment.byteSize !== metadata.size) {
          throw new Error('relay attachment size mismatch')
        }
        batchBytes += metadata.size
        if (batchBytes > maxBatchBytes) throw new Error('relay attachment batch exceeds maximum size')
        sources.push({ job, attachment, index, localPath, byteSize: metadata.size })
      } catch (error) {
        throw preparationError(error, job.jobId)
      }
    }
  }

  const preparedByJob = new Map(batch.jobs.map(job => [job.jobId, []]))
  for (const source of sources) {
    const { job, attachment, index, localPath, byteSize } = source
    try {
      const bytes = Buffer.from(await readFileImpl(localPath))
      if (bytes.length !== byteSize) throw new Error('relay attachment changed while being read')
      const digest = sha256(bytes)
      if (attachment.sha256 && attachment.sha256 !== digest) throw new Error('relay attachment hash mismatch')
      const transferId = transferIdFor(job.jobId, attachment, index, digest)
      const wire = wireAttachment(attachment, transferId, bytes.length, digest)
      const chunkFrame = {
        type: 'attachment_chunk',
        batchId: batch.batchId,
        transferId,
        index: 0,
      }
      const bytesPerChunk = chunkByteLimit(chunkFrame, frameMaxBytes)
      const chunkCount = bytes.length === 0 ? 0 : Math.ceil(bytes.length / bytesPerChunk)
      const manifest = {
        type: 'attachment_manifest',
        batchId: batch.batchId,
        jobId: job.jobId,
        transferId,
        updateId: String(job.payload?.telegramContext?.updateId ?? ''),
        attachment: wire,
        chunkCount,
      }
      assertFrameSize(manifest, frameMaxBytes)
      frames.push(manifest)
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const frame = {
          ...chunkFrame,
          index: chunkIndex,
          data: bytes.subarray(chunkIndex * bytesPerChunk, (chunkIndex + 1) * bytesPerChunk).toString('base64'),
        }
        assertFrameSize(frame, frameMaxBytes)
        frames.push(frame)
      }
      preparedByJob.get(job.jobId).push(wire)
    } catch (error) {
      throw preparationError(error, job.jobId)
    }
  }

  for (const job of batch.jobs) {
    const sourceAttachments = job.payload?.attachments ?? []
    const attachments = preparedByJob.get(job.jobId)
    jobs.push({
      ...job,
      payload: {
        ...job.payload,
        ...(sourceAttachments.length > 0 ? { attachments } : {}),
      },
    })
  }

  return {
    batch: { ...batch, jobs },
    frames,
    sourcePaths: sources.map(source => source.localPath),
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('relay attachment chunk is not valid base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('relay attachment chunk is not canonical base64')
  return bytes
}

export class RelayAttachmentReceiver {
  #store
  #maxAttachmentBytes
  #maxBatchBytes
  #transfers = new Map()
  #batchBytes = new Map()

  constructor({
    attachmentStore,
    maxAttachmentBytes = DEFAULT_RELAY_ATTACHMENT_MAX_BYTES,
    maxBatchBytes = DEFAULT_RELAY_ATTACHMENT_BATCH_MAX_BYTES,
  }) {
    if (!attachmentStore?.save) throw new Error('relay attachment store is required')
    this.#store = attachmentStore
    this.#maxAttachmentBytes = maxAttachmentBytes
    this.#maxBatchBytes = maxBatchBytes
  }

  async handleFrame(frame) {
    if (frame.type === 'attachment_manifest') return this.#handleManifest(frame)
    if (frame.type === 'attachment_chunk') return this.#handleChunk(frame)
    throw new Error(`unsupported relay attachment frame: ${frame.type}`)
  }

  async #handleManifest(frame) {
    const transferId = requireString(frame.transferId, 'relay attachment transferId')
    if (!TRANSFER_ID.test(transferId)) throw new Error('invalid relay attachment transferId')
    if (this.#transfers.has(transferId)) throw new Error('duplicate relay attachment manifest')
    const batchId = requireString(frame.batchId, 'relay attachment batchId')
    const jobId = requireString(frame.jobId, 'relay attachment jobId')
    const updateId = requireString(frame.updateId, 'relay attachment updateId')
    if (!/^\d+$/u.test(updateId)) throw new Error('invalid relay attachment updateId')
    const attachment = frame.attachment
    if (!attachment || !KIND.test(attachment.kind ?? '')) throw new Error('invalid relay attachment kind')
    requireString(attachment.fileId, 'relay attachment fileId')
    if (attachment.codexInput !== undefined && attachment.codexInput !== 'localImage') {
      throw new Error('invalid relay attachment Codex input type')
    }
    if (attachment.codexInput === 'localImage' && !isSupportedImageMime(attachment.detectedMimeType)) {
      throw new Error('invalid relay attachment image type')
    }
    if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 0) {
      throw new Error('invalid relay attachment byte size')
    }
    if (attachment.byteSize > this.#maxAttachmentBytes) throw new Error('relay attachment exceeds maximum size')
    const nextBatchBytes = (this.#batchBytes.get(batchId) ?? 0) + attachment.byteSize
    if (nextBatchBytes > this.#maxBatchBytes) throw new Error('relay attachment batch exceeds maximum size')
    if (!SHA256.test(attachment.sha256 ?? '')) throw new Error('invalid relay attachment hash')
    if (!Number.isSafeInteger(frame.chunkCount) || frame.chunkCount < 0) {
      throw new Error('invalid relay attachment chunk count')
    }
    if ((attachment.byteSize === 0) !== (frame.chunkCount === 0)) {
      throw new Error('relay attachment chunk count does not match its size')
    }
    if (attachment.byteSize > 0 && frame.chunkCount > attachment.byteSize) {
      throw new Error('relay attachment chunk count exceeds its byte size')
    }
    const record = {
      transferId,
      batchId,
      jobId,
      updateId,
      attachment: { ...attachment },
      chunkCount: frame.chunkCount,
      chunks: [],
      receivedBytes: 0,
      saved: null,
    }
    this.#transfers.set(transferId, record)
    this.#batchBytes.set(batchId, nextBatchBytes)
    if (frame.chunkCount === 0) await this.#finalize(record)
  }

  async #handleChunk(frame) {
    const transferId = requireString(frame.transferId, 'relay attachment transferId')
    const record = this.#transfers.get(transferId)
    if (!record) throw new Error('relay attachment chunk has no manifest')
    if (frame.batchId !== record.batchId) throw new Error('relay attachment chunk batch mismatch')
    if (frame.index !== record.chunks.length || frame.index >= record.chunkCount) {
      throw new Error('relay attachment chunk is out of order')
    }
    const bytes = decodeBase64(frame.data)
    if (bytes.length === 0) throw new Error('relay attachment chunk must not be empty')
    if (record.receivedBytes + bytes.length > record.attachment.byteSize) {
      this.#transfers.delete(transferId)
      throw new Error('relay attachment exceeds declared size')
    }
    record.chunks.push(bytes)
    record.receivedBytes += bytes.length
    if (record.chunks.length === record.chunkCount) await this.#finalize(record)
  }

  async #finalize(record) {
    try {
      const bytes = Buffer.concat(record.chunks)
      if (bytes.length !== record.attachment.byteSize) throw new Error('relay attachment size mismatch')
      if (sha256(bytes) !== record.attachment.sha256) throw new Error('relay attachment hash mismatch')
      record.saved = await this.#store.save({
        updateId: record.updateId,
        attachment: record.attachment,
        bytes,
      })
      record.chunks = []
      record.receivedBytes = 0
    } catch (error) {
      this.#transfers.delete(record.transferId)
      throw error
    }
  }

  materializeBatch(batch) {
    if (!batch?.batchId || !Array.isArray(batch.jobs)) throw new Error('relay attachment batch is malformed')
    const consumed = []
    const jobs = batch.jobs.map(job => {
      const sourceAttachments = job.payload?.attachments ?? []
      const attachments = sourceAttachments.map(attachment => {
        const record = this.#transfers.get(attachment.transferId)
        if (!record?.saved) throw new Error('relay attachment is incomplete')
        if (record.batchId !== batch.batchId || record.jobId !== job.jobId) {
          throw new Error('relay attachment identity mismatch')
        }
        if (JSON.stringify(attachmentIdentity(record.attachment)) !== JSON.stringify(attachmentIdentity(attachment))) {
          throw new Error('relay attachment identity mismatch')
        }
        consumed.push(attachment.transferId)
        return {
          ...attachment,
          localPath: record.saved.localPath,
          byteSize: record.saved.byteSize,
          sha256: record.saved.sha256,
        }
      })
      return {
        ...job,
        payload: {
          ...job.payload,
          ...(sourceAttachments.length > 0 ? { attachments } : {}),
        },
      }
    })
    for (const transferId of consumed) this.#transfers.delete(transferId)
    this.#batchBytes.delete(batch.batchId)
    return { ...batch, jobs }
  }

  clear() {
    this.#transfers.clear()
    this.#batchBytes.clear()
  }
}
