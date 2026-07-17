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
    relayAttachmentRoot: '/srv/codex-inbox',
    sessionLabel: 'tg-engage',
    frameMaxBytes: 65_536,
    coalesceQuietMs: 7_000,
    coalesceMaxMs: 30_000,
    remoteNodePath: '/usr/local/bin/node',
    remoteScriptPath: '/opt/codex-tg-bridge/src/relay-stdio.mjs',
  })

  assert.deepEqual(args.slice(0, 2), ['-T', '-i'])
  assert.equal(args.includes('BatchMode=yes'), true)
  assert.equal(args.includes('RequestTTY=no'), true)
  assert.equal(args.includes('ubuntu@relay.example'), true)
  assert.equal(args.includes('BRIDGE_SESSION_LABEL=tg-engage'), true)
  assert.equal(args.includes('BRIDGE_RELAY_COALESCE_QUIET_MS=7000'), true)
  assert.equal(args.includes('BRIDGE_RELAY_COALESCE_MAX_MS=30000'), true)
  assert.equal(args.includes('BRIDGE_RELAY_FRAME_MAX_BYTES=65536'), true)
  assert.equal(args.includes('BRIDGE_ATTACHMENT_ROOT=/srv/codex-inbox'), true)
  assert.equal(args.some(value => /token|secret/iu.test(value)), false)
})

test('builds a same-host relay process without SSH', () => {
  const spec = buildRelayProcessSpec({
    relayMode: 'local',
    localNodePath: '/home/user/runtime/node-v24/bin/node',
    localScriptPath: '/home/user/releases/release-a/src/relay-stdio.mjs',
    localDbPath: '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3',
    relayAttachmentRoot: '/home/user/codex-tg-bridge/.bridge-state/attachments',
    sessionLabel: 'tg-engage',
    frameMaxBytes: 65_536,
    coalesceQuietMs: 7_000,
    coalesceMaxMs: 30_000,
  }, { HOME: '/home/user' })

  assert.equal(spec.command, '/home/user/runtime/node-v24/bin/node')
  assert.deepEqual(spec.args, ['/home/user/releases/release-a/src/relay-stdio.mjs'])
  assert.equal(spec.env.BRIDGE_SESSION_LABEL, 'tg-engage')
  assert.equal(spec.env.BRIDGE_DB_PATH, '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3')
  assert.equal(spec.env.BRIDGE_ATTACHMENT_ROOT, '/home/user/codex-tg-bridge/.bridge-state/attachments')
  assert.equal(spec.env.BRIDGE_RELAY_COALESCE_QUIET_MS, '7000')
  assert.equal(spec.env.BRIDGE_RELAY_COALESCE_MAX_MS, '30000')
  assert.equal(spec.env.BRIDGE_RELAY_FRAME_MAX_BYTES, '65536')
  assert.equal(JSON.stringify(spec).includes('ssh'), false)
})
