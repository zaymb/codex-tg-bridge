import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AttachmentStore } from '../src/attachment-store.mjs'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-attachments-'))
  const root = join(dir, 'inbox')
  const exports = join(dir, 'exports')
  await mkdir(root)
  await mkdir(exports)
  return { dir, root, exports, store: await AttachmentStore.open({ root, exportRoots: [exports] }) }
}

test('stores a Telegram attachment under a deterministic sanitized path', async () => {
  const { root, store } = await fixture()
  const result = await store.save({
    updateId: '101',
    attachment: { kind: 'document', fileId: 'telegram-file-id', fileName: '../../secret report.pdf' },
    bytes: Buffer.from('pdf-data'),
  })

  assert.equal(result.created, true)
  assert.equal(result.localPath.startsWith(`${await realpath(root)}/101/`), true)
  assert.match(result.localPath, /\/document-[a-f0-9]{16}-secret_report\.pdf$/)
  assert.equal(await readFile(result.localPath, 'utf8'), 'pdf-data')
  assert.equal(result.byteSize, 8)
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal((await stat(result.localPath)).mode & 0o777, 0o640)
})

test('is idempotent for identical bytes and rejects conflicting content', async () => {
  const { store } = await fixture()
  const input = {
    updateId: '101',
    attachment: { kind: 'photo', fileId: 'same-file', fileName: null },
    bytes: Buffer.from('image'),
  }
  const first = await store.save(input)
  const second = await store.save(input)

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.localPath, first.localPath)
  await assert.rejects(store.save({ ...input, bytes: Buffer.from('changed') }), /existing attachment hash mismatch/)
})

test('rejects invalid update IDs and attachment kinds', async () => {
  const { store } = await fixture()
  await assert.rejects(
    store.save({ updateId: '../outside', attachment: { kind: 'photo', fileId: 'id' }, bytes: Buffer.from('x') }),
    /invalid update ID/,
  )
  await assert.rejects(
    store.save({ updateId: '1', attachment: { kind: '../../escape', fileId: 'id' }, bytes: Buffer.from('x') }),
    /invalid attachment kind/,
  )
})

test('accepts only existing regular files inside configured export roots', async () => {
  const { dir, exports, store } = await fixture()
  const valid = join(exports, 'report.txt')
  const outside = join(dir, 'outside.txt')
  await writeFile(valid, 'report')
  await writeFile(outside, 'outside')

  assert.equal(await store.assertExportPath(valid), await realpath(valid))
  await assert.rejects(store.assertExportPath(outside), /outside configured export roots/)
  await assert.rejects(store.assertExportPath(join(exports, 'missing.txt')), /cannot resolve export file/)
})

test('rejects a symlink inside an export root that escapes the root', async () => {
  const { dir, exports, store } = await fixture()
  const outside = join(dir, 'outside.txt')
  const link = join(exports, 'linked.txt')
  await writeFile(outside, 'outside')
  await symlink(outside, link)

  await assert.rejects(store.assertExportPath(link), /outside configured export roots/)
})
