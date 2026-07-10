import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { REQUIRED_PROTOCOL_SCHEMAS, captureContract, validateContract } from '../src/contract.mjs'

async function schemaFixture(omitMethod = null) {
  const root = await mkdtemp(join(tmpdir(), 'tg-bridge-contract-'))
  for (const [method, relativePath] of Object.entries(REQUIRED_PROTOCOL_SCHEMAS)) {
    if (method === omitMethod) continue
    const path = join(root, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ title: method, type: 'object' }))
  }
  return root
}

test('captures every required app-server schema with a stable sha256 hash', async () => {
  const schemaDir = await schemaFixture()
  const contract = await captureContract({ schemaDir, codexVersion: 'codex-cli 0.143.0' })

  assert.equal(contract.codexVersion, 'codex-cli 0.143.0')
  assert.equal(contract.protocol, 'codex-app-server')
  assert.deepEqual(Object.keys(contract.schemas).sort(), Object.keys(REQUIRED_PROTOCOL_SCHEMAS).sort())
  for (const entry of Object.values(contract.schemas)) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    assert.match(entry.path, /\.json$/)
  }
})

test('fails capture when a required approval schema is absent', async () => {
  const missingMethod = 'item/permissions/requestApproval'
  const schemaDir = await schemaFixture(missingMethod)

  await assert.rejects(
    captureContract({ schemaDir, codexVersion: 'codex-cli 0.143.0' }),
    new RegExp(`missing required Codex schema for ${missingMethod}`),
  )
})

test('rejects a contract whose required method path or hash is invalid', async () => {
  const schemaDir = await schemaFixture()
  const contract = await captureContract({ schemaDir, codexVersion: 'codex-cli 0.143.0' })

  delete contract.schemas['turn/completed']
  assert.throws(() => validateContract(contract), /contract is missing turn\/completed/)

  const valid = await captureContract({ schemaDir, codexVersion: 'codex-cli 0.143.0' })
  valid.schemas['turn/start'].sha256 = 'not-a-hash'
  assert.throws(() => validateContract(valid), /invalid schema hash for turn\/start/)
})
