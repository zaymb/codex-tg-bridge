import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRelayProcessSpec,
  buildRelaySshArgs,
  loadConnectorEnv,
} from '../src/local-connector-index.mjs'

test('loads task admission from the launcher config for a hot connector restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'connector-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'local-channel.json')
  await writeFile(configPath, JSON.stringify({
    taskAdmission: {
      cliPath: '/opt/taskq/taskq.py',
      dbPath: '/var/lib/taskq/tasks.sqlite3',
      agentId: 'elio',
    },
    interruptFanout: {
      command: '/opt/local/interrupt-peer',
      stopFlagPath: '/var/run/local/stop.flag',
    },
  }))

  const loaded = await loadConnectorEnv({ BRIDGE_LOCAL_CONFIG: configPath })

  assert.equal(loaded.TASKQ_CLI_PATH, '/opt/taskq/taskq.py')
  assert.equal(loaded.TASKQ_DB_PATH, '/var/lib/taskq/tasks.sqlite3')
  assert.equal(loaded.TASKQ_AGENT_ID, 'elio')
  assert.equal(loaded.BRIDGE_INTERRUPT_FANOUT_COMMAND, '/opt/local/interrupt-peer')
  assert.equal(loaded.BRIDGE_STOP_FLAG_PATH, '/var/run/local/stop.flag')
})

test('explicit task admission environment wins over the launcher config', async () => {
  const env = {
    TASKQ_CLI_PATH: '/explicit/taskq.py',
    TASKQ_DB_PATH: '/explicit/tasks.sqlite3',
    TASKQ_AGENT_ID: 'explicit-agent',
    BRIDGE_INTERRUPT_FANOUT_COMMAND: '/explicit/interrupt-peer',
    BRIDGE_STOP_FLAG_PATH: '/explicit/stop.flag',
  }

  assert.equal(await loadConnectorEnv(env), env)
})

test('loads only the missing local connector settings without overriding explicit values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'connector-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'local-channel.json')
  await writeFile(configPath, JSON.stringify({
    taskAdmission: {
      cliPath: '/opt/taskq/taskq.py',
      dbPath: '/var/lib/taskq/tasks.sqlite3',
      agentId: 'elio',
    },
    interruptFanout: {
      command: '/opt/local/interrupt-peer',
      stopFlagPath: '/var/run/local/stop.flag',
    },
  }))
  const loaded = await loadConnectorEnv({
    BRIDGE_LOCAL_CONFIG: configPath,
    TASKQ_CLI_PATH: '/explicit/taskq.py',
    TASKQ_DB_PATH: '/explicit/tasks.sqlite3',
    TASKQ_AGENT_ID: 'explicit-agent',
  })

  assert.equal(loaded.TASKQ_CLI_PATH, '/explicit/taskq.py')
  assert.equal(loaded.BRIDGE_INTERRUPT_FANOUT_COMMAND, '/opt/local/interrupt-peer')
  assert.equal(loaded.BRIDGE_STOP_FLAG_PATH, '/var/run/local/stop.flag')
})

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
