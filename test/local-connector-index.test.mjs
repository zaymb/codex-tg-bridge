import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRelaySshArgs } from '../src/local-connector-index.mjs'

test('builds a non-interactive SSH relay command without Telegram credentials', () => {
  const args = buildRelaySshArgs({
    sshIdentityFile: '/home/local/.ssh/id_ed25519',
    sshUser: 'ubuntu',
    sshHost: 'relay.example',
    remoteServiceUser: 'tgbridge',
    remoteDbPath: '/var/lib/codex-tg-bridge/bridge.sqlite3',
    sessionLabel: 'tg-engage',
    remoteNodePath: '/usr/local/bin/node',
    remoteScriptPath: '/opt/tg-engage/bridge/src/relay-stdio.mjs',
  })

  assert.deepEqual(args.slice(0, 2), ['-T', '-i'])
  assert.equal(args.includes('BatchMode=yes'), true)
  assert.equal(args.includes('ubuntu@relay.example'), true)
  assert.equal(args.includes('BRIDGE_SESSION_LABEL=tg-engage'), true)
  assert.equal(args.some(value => /token|secret/iu.test(value)), false)
})
