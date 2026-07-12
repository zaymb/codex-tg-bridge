import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadConfig, loadLocalConnectorConfig, loadTransportConfig } from '../src/config.mjs'

async function tokenFixture(mode = 0o600, content = '123456:secret-token\n') {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-config-'))
  const path = join(dir, 'telegram-token')
  await writeFile(path, content, { mode })
  await chmod(path, mode)
  return path
}

function validEnv(tokenPath) {
  return {
    TELEGRAM_TOKEN_FILE: tokenPath,
    TELEGRAM_OWNER_USER_ID: '9007199254740993123',
    TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890123456, -42, -42',
    TELEGRAM_ALLOWED_CHANNEL_IDS: '-1007777777777777777',
    TELEGRAM_CHAT_ALIASES: '{"sandbox":"-1001234567890123456"}',
    APP_SERVER_SOCKET: '/run/codex-tg/app/app.sock',
    BRIDGE_ACTION_SOCKET: '/run/codex-tg/bridge/action.sock',
    BRIDGE_WAKE_SOCKET: '/run/codex-tg/bridge/wake.sock',
    BRIDGE_DB_PATH: '/var/lib/codex-tg-bridge/bridge.sqlite3',
    BRIDGE_ATTACHMENT_ROOT: '/var/lib/codex-tg-bridge/attachments',
    BRIDGE_EXPORT_ROOTS: '/srv/codex-workspace/exports,/srv/codex-workspace/out',
    CODEX_WORKDIR: '/srv/codex-workspace',
    CODEX_WRITABLE_ROOTS: '/srv/codex-workspace',
    CODEX_CONTRACT_PATH: '/opt/codex-tg-bridge/fixtures/contract.json',
  }
}

test('loads production config without rounding Telegram IDs', async () => {
  const tokenPath = await tokenFixture()
  const config = loadConfig(validEnv(tokenPath))

  assert.equal(config.ownerUserId, '9007199254740993123')
  assert.deepEqual([...config.allowedChatIds], ['-1001234567890123456', '-42'])
  assert.deepEqual([...config.allowedChannelIds], ['-1007777777777777777'])
  assert.equal(config.chatAliases.get('sandbox'), '-1001234567890123456')
  assert.equal(config.maxConcurrentTurns, 2)
  assert.equal(config.pollTimeoutSec, 50)
  assert.equal(config.turnTimeoutMs, 900_000)
  assert.equal(config.updateLeaseMs, 120_000)
  assert.equal(config.typingIntervalMs, 4_000)
  assert.equal(config.effort, 'high')
})

test('accepts a forum-topic alias when its base group is approved', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)
  env.TELEGRAM_CHAT_ALIASES = '{"sandbox-topic":"-1001234567890123456:77"}'

  const config = loadConfig(env)

  assert.equal(config.chatAliases.get('sandbox-topic'), '-1001234567890123456:77')
})

test('reads and trims the token only through a non-enumerable function', async () => {
  const tokenPath = await tokenFixture()
  const config = loadConfig(validEnv(tokenPath))

  assert.equal(config.readTelegramToken(), '123456:secret-token')
  assert.equal(Object.keys(config).includes('readTelegramToken'), false)
  assert.doesNotMatch(JSON.stringify(config), /secret-token/)
})

test('rejects token environment variables unless explicitly enabled for development', () => {
  const env = validEnv('/missing/token')
  delete env.TELEGRAM_TOKEN_FILE
  env.TELEGRAM_BOT_TOKEN = '123456:dev-token'

  assert.throws(() => loadConfig(env), /TELEGRAM_TOKEN_FILE is required/)

  env.BRIDGE_ALLOW_TOKEN_ENV = 'true'
  const config = loadConfig(env)
  assert.equal(config.readTelegramToken(), '123456:dev-token')
})

test('rejects an empty or group-readable production token file', async () => {
  const emptyPath = await tokenFixture(0o600, '\n')
  const publicPath = await tokenFixture(0o644)

  assert.throws(() => loadConfig(validEnv(emptyPath)), /token file is empty/)
  assert.throws(() => loadConfig(validEnv(publicPath)), /must not be accessible by group or others/)
})

test('rejects malformed Telegram IDs and aliases to unknown chats', async () => {
  const tokenPath = await tokenFixture()
  const malformed = validEnv(tokenPath)
  malformed.TELEGRAM_OWNER_USER_ID = '9.5'
  assert.throws(() => loadConfig(malformed), /TELEGRAM_OWNER_USER_ID/)

  const unknownAlias = validEnv(tokenPath)
  unknownAlias.TELEGRAM_CHAT_ALIASES = '{"unknown":"-1000000000000000000"}'
  assert.throws(() => loadConfig(unknownAlias), /alias unknown targets an unapproved chat/)

  const reservedAlias = validEnv(tokenPath)
  reservedAlias.TELEGRAM_CHAT_ALIASES = '{"owner":"-1001234567890123456"}'
  assert.throws(() => loadConfig(reservedAlias), /alias owner is reserved/)
})

test('requires every filesystem path to be absolute', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)
  env.BRIDGE_DB_PATH = './bridge.sqlite3'

  assert.throws(() => loadConfig(env), /BRIDGE_DB_PATH must be an absolute path/)
})

test('validates bounded numeric settings', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)
  env.BRIDGE_MAX_CONCURRENT_TURNS = '0'
  assert.throws(() => loadConfig(env), /BRIDGE_MAX_CONCURRENT_TURNS must be between 1 and 16/)

  env.BRIDGE_MAX_CONCURRENT_TURNS = '3'
  env.BRIDGE_POLL_TIMEOUT_SEC = '51'
  assert.throws(() => loadConfig(env), /BRIDGE_POLL_TIMEOUT_SEC must be between 1 and 50/)
})

test('loads the transport-only config without Codex app-server settings', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)
  env.BRIDGE_SESSION_LABEL = 'tg-engage'
  delete env.APP_SERVER_SOCKET
  delete env.BRIDGE_ACTION_SOCKET
  delete env.BRIDGE_WAKE_SOCKET
  delete env.CODEX_WORKDIR
  delete env.CODEX_WRITABLE_ROOTS
  delete env.CODEX_CONTRACT_PATH

  const config = loadTransportConfig(env)

  assert.equal(config.sessionLabel, 'tg-engage')
  assert.equal(config.dbPath, '/var/lib/codex-tg-bridge/bridge.sqlite3')
  assert.equal(config.pollTimeoutSec, 50)
  assert.equal(config.updateLeaseMs, 120_000)
  assert.equal(config.deliverAllGroupMessages, false)
  assert.equal(config.deliverBotMessages, false)
  assert.equal(config.readTelegramToken(), '123456:secret-token')
  assert.equal(Object.keys(config).includes('readTelegramToken'), false)
})

test('requires a normalized transport session label', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)

  assert.throws(() => loadTransportConfig(env), /BRIDGE_SESSION_LABEL/)
  env.BRIDGE_SESSION_LABEL = 'contains spaces'
  assert.throws(() => loadTransportConfig(env), /BRIDGE_SESSION_LABEL/)
})

test('can explicitly enable approved-group passthrough for transport testing', async () => {
  const tokenPath = await tokenFixture()
  const env = validEnv(tokenPath)
  env.BRIDGE_SESSION_LABEL = 'tg-engage'
  env.BRIDGE_DELIVER_ALL_GROUP_MESSAGES = 'true'
  env.BRIDGE_DELIVER_BOT_MESSAGES = 'true'

  assert.equal(loadTransportConfig(env).deliverAllGroupMessages, true)
  assert.equal(loadTransportConfig(env).deliverBotMessages, true)
})

test('loads explicit no-prompt permissions for the local Telegram connector', () => {
  const env = {
    BRIDGE_SESSION_LABEL: 'tg-engage',
    CODEX_SESSION_ID: 'session-a',
    APP_SERVER_SOCKET: '/tmp/app.sock',
    CODEX_CONTRACT_PATH: '/opt/codex-tg-bridge/contract.json',
    BRIDGE_RELAY_HOST: 'relay.example',
    BRIDGE_RELAY_SSH_USER: 'ubuntu',
    BRIDGE_RELAY_IDENTITY_FILE: '/home/alta/.ssh/id_ed25519',
    CODEX_APPROVAL_POLICY: 'never',
    CODEX_SANDBOX_MODE: 'danger-full-access',
  }

  const config = loadLocalConnectorConfig(env)
  assert.equal(config.approvalPolicy, 'never')
  assert.deepEqual(config.sandboxPolicy, { type: 'dangerFullAccess' })
  env.CODEX_APPROVAL_POLICY = 'sometimes'
  assert.throws(() => loadLocalConnectorConfig(env), /CODEX_APPROVAL_POLICY/)
  env.CODEX_APPROVAL_POLICY = 'never'
  env.CODEX_SANDBOX_MODE = 'everything'
  assert.throws(() => loadLocalConnectorConfig(env), /CODEX_SANDBOX_MODE/)
})

test('loads a same-host relay without requiring SSH configuration', () => {
  const config = loadLocalConnectorConfig({
    BRIDGE_SESSION_LABEL: 'tg-engage',
    CODEX_SESSION_ID: 'session-a',
    APP_SERVER_SOCKET: '/run/user/1000/codex-app.sock',
    CODEX_CONTRACT_PATH: '/home/user/bridge/contract.json',
    BRIDGE_RELAY_MODE: 'local',
    BRIDGE_RELAY_NODE_PATH: '/home/user/runtime/node-v24/bin/node',
    BRIDGE_RELAY_SCRIPT_PATH: '/home/user/releases/release-a/src/relay-stdio.mjs',
    BRIDGE_RELAY_DB_PATH: '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3',
  })

  assert.equal(config.relayMode, 'local')
  assert.equal(config.localNodePath, '/home/user/runtime/node-v24/bin/node')
  assert.equal(config.localScriptPath, '/home/user/releases/release-a/src/relay-stdio.mjs')
  assert.equal(config.localDbPath, '/home/user/codex-tg-bridge/.bridge-state/bridge.sqlite3')
  assert.equal('sshIdentityFile' in config, false)
})
