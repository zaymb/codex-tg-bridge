import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRelayProcessSpec, buildRelaySshArgs } from '../src/local-connector-index.mjs'

test('builds a non-interactive SSH relay command without Telegram credentials', () => {
  const args = buildRelaySshArgs({
    sshIdentityFile: '/home/local/.ssh/id_ed25519',
    sshUser: 'ubuntu',
    sshHost: 'relay.example',
    remoteServiceUser: 'tgbridge',
    remoteDbPath: '/var/lib/codex-tg-bridge/bridge.sqlite3',
    sessionLabel: 'tg-engage',
    remoteNodePath: '/usr/local/bin/node',
    remoteScriptPath: '/opt/codex-tg-bridge/src/relay-stdio.mjs',
  })

  assert.deepEqual(args.slice(0, 2), ['-T', '-i'])
  assert.equal(args.includes('BatchMode=yes'), true)
  assert.equal(args.includes('RequestTTY=no'), true)
  assert.equal(args.includes('ubuntu@relay.example'), true)
  assert.equal(args.includes('BRIDGE_SESSION_LABEL=tg-engage'), true)
  assert.equal(args.some(value => /token|secret/iu.test(value)), false)
})

test('builds a same-host relay process without SSH', () => {
  const spec = buildRelayProcessSpec({
    relayMode: 'local',
    localNodePath: '/home/user/runtime/node-v24/bin/node',
    localScriptPath: '/home/user/releases/release-a/src/relay-stdio.mjs',
    localDbPath: '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3',
    sessionLabel: 'tg-engage',
  }, { HOME: '/home/user' })

  assert.equal(spec.command, '/home/user/runtime/node-v24/bin/node')
  assert.deepEqual(spec.args, ['/home/user/releases/release-a/src/relay-stdio.mjs'])
  assert.equal(spec.env.BRIDGE_SESSION_LABEL, 'tg-engage')
  assert.equal(spec.env.BRIDGE_DB_PATH, '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3')
  assert.equal(JSON.stringify(spec).includes('ssh'), false)
})
