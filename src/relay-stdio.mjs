#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import { loadRelayConfig } from './config.mjs'
import { RelayProtocolSession, RELAY_PROTOCOL_VERSION } from './relay-protocol.mjs'
import { StateStore } from './state-store.mjs'

export async function main(env = process.env, input = process.stdin, output = process.stdout) {
  const config = loadRelayConfig(env)
  const stateStore = StateStore.open(config.dbPath)
  const writeFrame = frame => output.write(`${JSON.stringify(frame)}\n`)
  const session = new RelayProtocolSession({
    stateStore,
    sessionLabel: config.sessionLabel,
    writeFrame,
    leaseMs: config.sessionLeaseMs,
    jobLeaseMs: config.jobLeaseMs,
    frameMaxBytes: config.frameMaxBytes,
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  let fatalError = null
  const claimTimer = setInterval(() => {
    chain = chain.then(() => session.claimOnce()).catch(error => { fatalError = error; lines.close() })
  }, config.claimIntervalMs)
  claimTimer.unref?.()

  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > config.frameMaxBytes) throw new Error('relay frame exceeds maximum size')
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        throw new Error('relay frame is not valid JSON')
      }
      await (chain = chain.then(() => session.handleFrame(frame)))
    }
    await chain
    if (fatalError) throw fatalError
  } catch (error) {
    writeFrame({ version: RELAY_PROTOCOL_VERSION, type: 'error', message: error.message })
    throw error
  } finally {
    clearInterval(claimTimer)
    lines.close()
    await session.close()
    stateStore.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'relay_fatal', message: error.message }))
    process.exitCode = 1
  }
}
