#!/usr/bin/env node

import { loadTransportConfig } from './config.mjs'
import { isMainModule } from './main-module.mjs'
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

if (isMainModule(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    if (error.name === 'DisengagedError') {
      // Deliberate admin disengage: exit through the existing systemd
      // RestartPreventExitStatus=78 contract so the unit stays down until a
      // human re-engages it. Not a fault — logged as info, not error.
      console.log(JSON.stringify({
        level: 'info',
        event: 'transport_disengaged',
      }))
      process.exitCode = 78
    } else {
      console.error(JSON.stringify({
        level: 'error',
        event: 'transport_fatal',
        error: { name: error.name, message: error.message },
      }))
      process.exitCode = error.name === 'DuplicatePollerError' ? 78 : 1
    }
  }
}
