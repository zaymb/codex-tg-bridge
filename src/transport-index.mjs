#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

import { loadTransportConfig } from './config.mjs'
import { createTransportRuntime } from './transport-runtime.mjs'

export async function main(env = process.env) {
  const config = loadTransportConfig(env)
  const runtime = await createTransportRuntime({ config })
  const controller = new AbortController()
  const shutdown = () => controller.abort()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(JSON.stringify({
    level: 'info',
    event: 'transport_ready',
    sessionLabel: config.sessionLabel,
  }))
  try {
    await runtime.run({ signal: controller.signal })
  } finally {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    runtime.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'transport_fatal',
      error: { name: error.name, message: error.message },
    }))
    process.exitCode = error.name === 'DuplicatePollerError' ? 78 : 1
  }
}
