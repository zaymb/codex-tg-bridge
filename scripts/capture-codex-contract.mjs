#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { captureContract } from '../src/contract.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`)
    }
    args[key.slice(2)] = value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args['schema-dir'] || !args['codex-version'] || !args.out) {
  throw new Error('usage: capture-codex-contract --schema-dir DIR --codex-version VERSION --out FILE')
}

const contract = await captureContract({
  schemaDir: args['schema-dir'],
  codexVersion: args['codex-version'],
})
await mkdir(dirname(args.out), { recursive: true })
await writeFile(args.out, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o644 })
console.log(`captured ${Object.keys(contract.schemas).length} Codex app-server schemas`)
