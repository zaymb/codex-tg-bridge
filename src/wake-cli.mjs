#!/usr/bin/env node

import { randomUUID } from 'node:crypto'

import { ControlClient } from './control-client.mjs'
import { isMainModule } from './main-module.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    args[key.slice(2)] = value
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const socketPath = process.env.BRIDGE_WAKE_SOCKET
  if (!socketPath) throw new Error('BRIDGE_WAKE_SOCKET is required')
  const nowMs = Date.now()
  const expiresInSec = Number(args['expires-in-sec'] ?? 600)
  if (!Number.isSafeInteger(expiresInSec) || expiresInSec < 1) throw new Error('--expires-in-sec must be a positive integer')
  const context = args['context-json'] ? JSON.parse(args['context-json']) : null
  const client = await ControlClient.connect({ socketPath })
  try {
    const result = await client.request('enqueue_wake', {
      target: args.target,
      source: args.source ?? 'manual',
      reason: args.reason,
      context,
      dedupeKey: args['dedupe-key'],
      earliestAtMs: nowMs,
      expiresAtMs: nowMs + expiresInSec * 1_000,
    }, { actionId: `wake-cli:${randomUUID()}` })
    console.log(JSON.stringify(result))
  } finally {
    client.close()
  }
}

if (isMainModule(import.meta.url)) {
  await main()
}
