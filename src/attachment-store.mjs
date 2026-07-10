import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

const KIND = /^[a-z][a-z0-9_]{0,31}$/

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root, path) {
  const result = relative(root, path)
  return result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result))
}

function sanitizedFileName(value, kind) {
  const fallback = {
    photo: 'image.jpg',
    voice: 'voice.ogg',
    video_note: 'video-note.mp4',
    sticker: 'sticker.bin',
  }[kind] ?? `${kind}.bin`
  const source = basename(value || fallback)
  const sanitized = source
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[_\.]+|[_\.]+$/gu, '')
  return (sanitized || fallback).slice(0, 120)
}

export class AttachmentStore {
  static async open({ root, exportRoots = [] }) {
    await mkdir(root, { recursive: true, mode: 0o750 })
    const canonicalRoot = await realpath(root)
    const canonicalExportRoots = []
    for (const exportRoot of exportRoots) {
      try {
        canonicalExportRoots.push(await realpath(exportRoot))
      } catch (error) {
        throw new Error(`cannot resolve export root ${exportRoot}: ${error.message}`)
      }
    }
    return new AttachmentStore(canonicalRoot, canonicalExportRoots)
  }

  #root
  #exportRoots

  constructor(root, exportRoots) {
    this.#root = root
    this.#exportRoots = exportRoots
  }

  async save({ updateId, attachment, bytes }) {
    updateId = String(updateId)
    if (!/^\d+$/.test(updateId)) throw new Error('invalid update ID')
    if (!attachment || !KIND.test(attachment.kind ?? '')) throw new Error('invalid attachment kind')
    if (!attachment.fileId) throw new Error('attachment fileId is required')
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new Error('attachment bytes must be a Buffer or Uint8Array')
    }

    const directory = join(this.#root, updateId)
    await mkdir(directory, { recursive: true, mode: 0o750 })
    const canonicalDirectory = await realpath(directory)
    if (!isWithin(this.#root, canonicalDirectory)) throw new Error('attachment directory escaped configured root')

    const fileIdHash = sha256(String(attachment.fileId)).slice(0, 16)
    const fileName = sanitizedFileName(attachment.fileName, attachment.kind)
    const localPath = join(canonicalDirectory, `${attachment.kind}-${fileIdHash}-${fileName}`)
    const content = Buffer.from(bytes)
    const contentHash = sha256(content)

    try {
      const existing = await readFile(localPath)
      if (sha256(existing) !== contentHash) throw new Error('existing attachment hash mismatch')
      return { created: false, localPath, byteSize: existing.length, sha256: contentHash }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const temporaryPath = join(canonicalDirectory, `.${randomUUID()}.tmp`)
    await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o640 })
    try {
      await link(temporaryPath, localPath)
      await chmod(localPath, 0o640)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readFile(localPath)
      if (sha256(existing) !== contentHash) throw new Error('existing attachment hash mismatch')
      return { created: false, localPath, byteSize: existing.length, sha256: contentHash }
    } finally {
      await unlink(temporaryPath).catch(() => {})
    }
    return { created: true, localPath, byteSize: content.length, sha256: contentHash }
  }

  async assertExportPath(path) {
    let canonical
    try {
      canonical = await realpath(path)
    } catch (error) {
      throw new Error(`cannot resolve export file: ${error.message}`)
    }
    const metadata = await stat(canonical)
    if (!metadata.isFile()) throw new Error('export path must be a regular file')
    if (!this.#exportRoots.some(root => isWithin(root, canonical) && canonical !== root)) {
      throw new Error('export file is outside configured export roots')
    }
    return canonical
  }
}
