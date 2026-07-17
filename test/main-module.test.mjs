import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { isMainModule } from '../src/main-module.mjs'

test('recognizes a directly invoked module and rejects another path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-main-module-'))
  const entry = join(directory, 'entry.mjs')
  const other = join(directory, 'other.mjs')
  await writeFile(entry, '')
  await writeFile(other, '')

  assert.equal(isMainModule(pathToFileURL(entry).href, entry), true)
  assert.equal(isMainModule(pathToFileURL(entry).href, other), false)
})

test('recognizes an entry point invoked through a release symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-main-symlink-'))
  const release = join(directory, 'releases', 'release-a')
  const entry = join(release, 'src', 'entry.mjs')
  await mkdir(join(release, 'src'), { recursive: true })
  await writeFile(entry, '')
  await symlink(join('releases', 'release-a'), join(directory, 'current'))

  assert.equal(
    isMainModule(pathToFileURL(entry).href, join(directory, 'current', 'src', 'entry.mjs')),
    true,
  )
})
