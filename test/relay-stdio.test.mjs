import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createFrameWriter } from '../src/relay-stdio.mjs'

test('waits for output drain when relay transport applies backpressure', async () => {
  const output = new EventEmitter()
  const writes = []
  output.write = value => {
    writes.push(value)
    return false
  }
  const writeFrame = createFrameWriter(output)
  let settled = false
  const writing = writeFrame({ version: 1, type: 'heartbeat' }).then(() => { settled = true })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  output.emit('drain')
  await writing
  assert.equal(writes.length, 1)
})
