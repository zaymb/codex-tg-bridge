import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { engageLocalConnector } from '../src/local-engage.mjs'

test('signals only the launcher recorded in a disengaged channel status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-local-engage-'))
  const configPath = join(root, 'local-channel.json')
  const statusPath = join(root, 'channel-status.json')
  await writeFile(configPath, JSON.stringify({ statusPath }))
  await writeFile(statusPath, JSON.stringify({
    status: 'disengaged',
    launcherPid: 4321,
    codexSessionId: 'session-a',
  }))
  const signals = []

  const result = await engageLocalConnector({
    configPath,
    bridgeRoot: root,
    signalImpl: (pid, signal) => signals.push({ pid, signal }),
  })

  assert.deepEqual(signals, [{ pid: 4321, signal: 'SIGUSR1' }])
  assert.deepEqual(result, { launcherPid: 4321, codexSessionId: 'session-a' })
})

test('refuses to signal a channel that is not explicitly disengaged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-local-engage-'))
  const configPath = join(root, 'local-channel.json')
  const statusPath = join(root, 'channel-status.json')
  await writeFile(configPath, JSON.stringify({ statusPath }))
  await writeFile(statusPath, JSON.stringify({ status: 'connected', launcherPid: 4321 }))

  await assert.rejects(
    engageLocalConnector({ configPath, bridgeRoot: root, signalImpl: () => {} }),
    /channel is not disengaged/u,
  )
})
