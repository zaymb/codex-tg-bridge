import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fingerprintRuntimeSources } from '../src/runtime-fingerprint.mjs'

test('runtime fingerprint changes with executable source but ignores other files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-runtime-fingerprint-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'relay.mjs')
  await writeFile(source, 'export const value = 1\n')
  const initial = fingerprintRuntimeSources(root)

  await writeFile(join(root, 'README.md'), 'not executable\n')
  assert.equal(fingerprintRuntimeSources(root), initial)

  await writeFile(source, 'export const value = 2\n')
  assert.notEqual(fingerprintRuntimeSources(root), initial)
})
