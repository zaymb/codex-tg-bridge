#!/usr/bin/env node

import { loadConfig } from './config.mjs'
import { isMainModule } from './main-module.mjs'
import { createBridgeRuntime } from './runtime.mjs'

export async function main(env = process.env) {
  const config = loadConfig(env)
  const runtime = await createBridgeRuntime({ config })
  const controller = new AbortController()
  const shutdown = () => controller.abort()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(JSON.stringify({ level: 'info', event: 'bridge_ready', bot: 'configured' }))
  try {
    await runtime.run({ signal: controller.signal })
  } finally {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    await runtime.close()
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'bridge_fatal',
      error: { name: error.name, message: error.message },
    }))
    process.exitCode = error.name === 'DuplicatePollerError' ? 78 : 1
  }
}
