import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const DECIMAL_ID = /^-?\d+$/
const POSITIVE_DECIMAL_ID = /^\d+$/
const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`expected true or false, received ${JSON.stringify(value)}`)
}

function parseInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function parseId(value, name, positiveOnly = false) {
  const pattern = positiveOnly ? POSITIVE_DECIMAL_ID : DECIMAL_ID
  if (!value || !pattern.test(value)) {
    throw new Error(`${name} must be a decimal Telegram ID string`)
  }
  return value
}

function parseIdSet(value, name) {
  const result = new Set()
  for (const item of (value ?? '').split(',')) {
    const trimmed = item.trim()
    if (!trimmed) continue
    result.add(parseId(trimmed, name))
  }
  return result
}

function requireAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return value
}

function parsePathList(value, name) {
  const result = []
  const seen = new Set()
  for (const item of (value ?? '').split(',')) {
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    result.push(requireAbsolutePath(trimmed, name))
    seen.add(trimmed)
  }
  return result
}

function parseAliases(value, allowedChatIds, allowedChannelIds) {
  if (!value) return new Map()
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('TELEGRAM_CHAT_ALIASES must be a JSON object')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('TELEGRAM_CHAT_ALIASES must be a JSON object')
  }

  const aliases = new Map()
  for (const [alias, target] of Object.entries(parsed)) {
    if (!ALIAS.test(alias)) throw new Error(`invalid Telegram chat alias: ${alias}`)
    if (alias === 'owner') throw new Error('Telegram chat alias owner is reserved')
    if (typeof target !== 'string') throw new Error(`alias ${alias} must target a conversation key string`)
    const match = target.match(/^(-?\d+)(?::(\d+))?$/u)
    if (!match) throw new Error(`alias ${alias} must target a Telegram conversation key`)
    const [, chatId, threadId] = match
    const approved = threadId
      ? allowedChatIds.has(chatId)
      : allowedChatIds.has(chatId) || allowedChannelIds.has(chatId)
    if (!approved) {
      throw new Error(`alias ${alias} targets an unapproved chat`)
    }
    aliases.set(alias, target)
  }
  return aliases
}

function createTokenReader(env) {
  if (env.TELEGRAM_TOKEN_FILE) {
    const tokenPath = requireAbsolutePath(env.TELEGRAM_TOKEN_FILE, 'TELEGRAM_TOKEN_FILE')
    let stat
    try {
      stat = statSync(tokenPath)
    } catch (error) {
      throw new Error(`cannot read TELEGRAM_TOKEN_FILE: ${error.message}`)
    }
    if (!stat.isFile()) throw new Error('TELEGRAM_TOKEN_FILE must point to a regular file')
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('TELEGRAM_TOKEN_FILE must not be accessible by group or others')
    }
    const read = () => {
      const token = readFileSync(tokenPath, 'utf8').trim()
      if (!token) throw new Error('Telegram token file is empty')
      return token
    }
    read()
    return { tokenFile: tokenPath, read }
  }

  if (!parseBoolean(env.BRIDGE_ALLOW_TOKEN_ENV, false)) {
    throw new Error('TELEGRAM_TOKEN_FILE is required in production')
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required when BRIDGE_ALLOW_TOKEN_ENV=true')
  return { tokenFile: null, read: () => token }
}

function attachTokenReader(config, read) {
  Object.defineProperty(config, 'readTelegramToken', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: read,
  })
  return config
}

function parseSessionLabel(value) {
  const label = value?.trim()
  if (!label || !ALIAS.test(label)) {
    throw new Error('BRIDGE_SESSION_LABEL must contain only letters, numbers, underscores, or hyphens')
  }
  return label
}

function requireSimpleValue(value, name) {
  const result = value?.trim()
  if (!result || !/^[A-Za-z0-9._:@-]+$/u.test(result)) {
    throw new Error(`${name} contains unsupported characters`)
  }
  return result
}

function parseChoice(value, name, choices, fallback = null) {
  const selected = value?.trim() || fallback
  if (!choices.includes(selected)) throw new Error(`${name} must be one of: ${choices.join(', ')}`)
  return selected
}

export function loadConfig(env = process.env) {
  const token = createTokenReader(env)
  const ownerUserId = parseId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID', true)
  const allowedChatIds = parseIdSet(env.TELEGRAM_ALLOWED_CHAT_IDS, 'TELEGRAM_ALLOWED_CHAT_IDS')
  const allowedChannelIds = parseIdSet(env.TELEGRAM_ALLOWED_CHANNEL_IDS, 'TELEGRAM_ALLOWED_CHANNEL_IDS')

  const config = {
    ownerUserId,
    allowedChatIds,
    allowedChannelIds,
    chatAliases: parseAliases(env.TELEGRAM_CHAT_ALIASES, allowedChatIds, allowedChannelIds),
    tokenFile: token.tokenFile,
    appServerSocket: requireAbsolutePath(env.APP_SERVER_SOCKET, 'APP_SERVER_SOCKET'),
    actionSocket: requireAbsolutePath(env.BRIDGE_ACTION_SOCKET, 'BRIDGE_ACTION_SOCKET'),
    wakeSocket: requireAbsolutePath(env.BRIDGE_WAKE_SOCKET, 'BRIDGE_WAKE_SOCKET'),
    dbPath: requireAbsolutePath(env.BRIDGE_DB_PATH, 'BRIDGE_DB_PATH'),
    attachmentRoot: requireAbsolutePath(env.BRIDGE_ATTACHMENT_ROOT, 'BRIDGE_ATTACHMENT_ROOT'),
    exportRoots: parsePathList(env.BRIDGE_EXPORT_ROOTS, 'BRIDGE_EXPORT_ROOTS'),
    codexWorkdir: requireAbsolutePath(env.CODEX_WORKDIR, 'CODEX_WORKDIR'),
    codexWritableRoots: parsePathList(env.CODEX_WRITABLE_ROOTS, 'CODEX_WRITABLE_ROOTS'),
    codexContractPath: requireAbsolutePath(env.CODEX_CONTRACT_PATH, 'CODEX_CONTRACT_PATH'),
    model: env.CODEX_MODEL?.trim() || null,
    effort: env.CODEX_EFFORT?.trim() || 'high',
    maxConcurrentTurns: parseInteger(env, 'BRIDGE_MAX_CONCURRENT_TURNS', 2, 1, 16),
    pollTimeoutSec: parseInteger(env, 'BRIDGE_POLL_TIMEOUT_SEC', 50, 1, 50),
    turnTimeoutMs: parseInteger(env, 'BRIDGE_TURN_TIMEOUT_MS', 900_000, 1_000, 3_600_000),
    updateLeaseMs: parseInteger(env, 'BRIDGE_UPDATE_LEASE_MS', 120_000, 1_000, 3_600_000),
    typingIntervalMs: parseInteger(env, 'BRIDGE_TYPING_INTERVAL_MS', 4_000, 1_000, 30_000),
    logLevel: env.BRIDGE_LOG_LEVEL?.trim() || 'info',
  }

  return attachTokenReader(config, token.read)
}

export function loadTransportConfig(env = process.env) {
  const token = createTokenReader(env)
  const ownerUserId = parseId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID', true)
  const allowedChatIds = parseIdSet(env.TELEGRAM_ALLOWED_CHAT_IDS, 'TELEGRAM_ALLOWED_CHAT_IDS')
  const allowedChannelIds = parseIdSet(env.TELEGRAM_ALLOWED_CHANNEL_IDS, 'TELEGRAM_ALLOWED_CHANNEL_IDS')
  const config = {
    ownerUserId,
    allowedChatIds,
    allowedChannelIds,
    chatAliases: parseAliases(env.TELEGRAM_CHAT_ALIASES, allowedChatIds, allowedChannelIds),
    tokenFile: token.tokenFile,
    sessionLabel: parseSessionLabel(env.BRIDGE_SESSION_LABEL),
    dbPath: requireAbsolutePath(env.BRIDGE_DB_PATH, 'BRIDGE_DB_PATH'),
    pollTimeoutSec: parseInteger(env, 'BRIDGE_POLL_TIMEOUT_SEC', 50, 1, 50),
    updateLeaseMs: parseInteger(env, 'BRIDGE_UPDATE_LEASE_MS', 120_000, 1_000, 3_600_000),
    deliverAllGroupMessages: parseBoolean(env.BRIDGE_DELIVER_ALL_GROUP_MESSAGES, false),
    deliverBotMessages: parseBoolean(env.BRIDGE_DELIVER_BOT_MESSAGES, false),
    logLevel: env.BRIDGE_LOG_LEVEL?.trim() || 'info',
  }
  return attachTokenReader(config, token.read)
}

export function loadRelayConfig(env = process.env) {
  return {
    sessionLabel: parseSessionLabel(env.BRIDGE_SESSION_LABEL),
    dbPath: requireAbsolutePath(env.BRIDGE_DB_PATH, 'BRIDGE_DB_PATH'),
    frameMaxBytes: parseInteger(env, 'BRIDGE_RELAY_FRAME_MAX_BYTES', 262_144, 1_024, 1_048_576),
    claimIntervalMs: parseInteger(env, 'BRIDGE_RELAY_CLAIM_INTERVAL_MS', 250, 50, 10_000),
    sessionLeaseMs: parseInteger(env, 'BRIDGE_RELAY_SESSION_LEASE_MS', 20_000, 5_000, 120_000),
    jobLeaseMs: parseInteger(env, 'BRIDGE_RELAY_JOB_LEASE_MS', 120_000, 10_000, 900_000),
  }
}

export function loadLocalConnectorConfig(env = process.env) {
  const relayMode = parseChoice(
    env.BRIDGE_RELAY_MODE,
    'BRIDGE_RELAY_MODE',
    ['ssh', 'local'],
    'ssh',
  )
  const sandboxMode = parseChoice(
    env.CODEX_SANDBOX_MODE,
    'CODEX_SANDBOX_MODE',
    ['read-only', 'workspace-write', 'danger-full-access'],
    'workspace-write',
  )
  const config = {
    ownerUserId: parseId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID', true),
    sessionLabel: parseSessionLabel(env.BRIDGE_SESSION_LABEL),
    codexSessionId: requireSimpleValue(env.CODEX_SESSION_ID, 'CODEX_SESSION_ID'),
    threadId: requireSimpleValue(env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID, 'CODEX_THREAD_ID'),
    appServerSocket: requireAbsolutePath(env.APP_SERVER_SOCKET, 'APP_SERVER_SOCKET'),
    contractPath: requireAbsolutePath(env.CODEX_CONTRACT_PATH, 'CODEX_CONTRACT_PATH'),
    relayMode,
    frameMaxBytes: parseInteger(env, 'BRIDGE_RELAY_FRAME_MAX_BYTES', 262_144, 1_024, 1_048_576),
    heartbeatIntervalMs: parseInteger(env, 'BRIDGE_RELAY_HEARTBEAT_INTERVAL_MS', 5_000, 1_000, 30_000),
    approvalPolicy: parseChoice(
      env.CODEX_APPROVAL_POLICY,
      'CODEX_APPROVAL_POLICY',
      ['untrusted', 'on-request', 'never'],
      'on-request',
    ),
    sandboxPolicy: sandboxMode === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : sandboxMode === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
  }
  if (relayMode === 'local') {
    return {
      ...config,
      localNodePath: requireAbsolutePath(env.BRIDGE_RELAY_NODE_PATH ?? process.execPath, 'BRIDGE_RELAY_NODE_PATH'),
      localScriptPath: requireAbsolutePath(env.BRIDGE_RELAY_SCRIPT_PATH, 'BRIDGE_RELAY_SCRIPT_PATH'),
      localDbPath: requireAbsolutePath(env.BRIDGE_RELAY_DB_PATH, 'BRIDGE_RELAY_DB_PATH'),
    }
  }
  return {
    ...config,
    sshPath: requireAbsolutePath(env.BRIDGE_SSH_PATH ?? '/usr/bin/ssh', 'BRIDGE_SSH_PATH'),
    sshHost: requireSimpleValue(env.BRIDGE_RELAY_HOST, 'BRIDGE_RELAY_HOST'),
    sshUser: requireSimpleValue(env.BRIDGE_RELAY_SSH_USER, 'BRIDGE_RELAY_SSH_USER'),
    sshIdentityFile: requireAbsolutePath(env.BRIDGE_RELAY_IDENTITY_FILE, 'BRIDGE_RELAY_IDENTITY_FILE'),
    remoteServiceUser: requireSimpleValue(env.BRIDGE_RELAY_SERVICE_USER ?? 'tgbridge', 'BRIDGE_RELAY_SERVICE_USER'),
    remoteNodePath: requireAbsolutePath(env.BRIDGE_RELAY_NODE_PATH ?? '/usr/local/bin/node', 'BRIDGE_RELAY_NODE_PATH'),
    remoteScriptPath: requireAbsolutePath(env.BRIDGE_RELAY_SCRIPT_PATH ?? '/opt/codex-tg-bridge/src/relay-stdio.mjs', 'BRIDGE_RELAY_SCRIPT_PATH'),
    remoteDbPath: requireAbsolutePath(env.BRIDGE_RELAY_DB_PATH ?? '/var/lib/codex-tg-bridge/bridge.sqlite3', 'BRIDGE_RELAY_DB_PATH'),
  }
}
