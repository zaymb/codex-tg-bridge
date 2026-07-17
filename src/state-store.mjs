import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = '2'

function stringify(value) {
  return value === undefined ? null : JSON.stringify(value)
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value)
}

function requireUpdateId(value) {
  const updateId = String(value)
  if (!/^\d+$/.test(updateId)) throw new Error('updateId must be an unsigned decimal string')
  return updateId
}

function mapUpdate(row) {
  if (!row) return null
  return {
    updateId: row.update_id,
    raw: parse(row.raw_json),
    normalizedType: row.normalized_type,
    conversationKey: row.conversation_key,
    status: row.status,
    attempts: row.attempts,
    availableAtMs: row.available_at_ms,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapConversation(row) {
  if (!row) return null
  return {
    conversationKey: row.conversation_key,
    threadId: row.thread_id,
    modelOverride: row.model_override,
    effortOverride: row.effort_override,
    activeTurnId: row.active_turn_id,
    activeTurnStartedAtMs: row.active_turn_started_at_ms,
    staleReason: row.stale_reason,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapOutbound(row) {
  if (!row) return null
  return {
    actionId: row.action_id,
    conversationKey: row.conversation_key,
    actionType: row.action_type,
    payload: parse(row.payload_json),
    sequenceGroup: row.sequence_group,
    sequenceIndex: row.sequence_index,
    status: row.status,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    result: parse(row.result_json),
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapBotReactionEvent(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    actionId: row.action_id,
    conversationKey: row.conversation_key,
    botId: row.bot_id,
    botUsername: row.bot_username,
    chatId: row.telegram_chat_id,
    messageId: row.telegram_message_id,
    reaction: parse(row.reaction_json),
    extendsCooldown: row.extends_cooldown === 1,
    createdAtMs: row.created_at_ms,
  }
}

function mapApproval(row) {
  if (!row) return null
  return {
    tokenHash: row.token_hash,
    requestId: row.request_id,
    method: row.method,
    conversationKey: row.conversation_key,
    threadId: row.thread_id,
    turnId: row.turn_id,
    ownerUserId: row.owner_user_id,
    expiresAtMs: row.expires_at_ms,
    state: row.state,
    response: parse(row.response_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapRelayApproval(row) {
  if (!row) return null
  return {
    approvalId: row.approval_id,
    sessionLabel: row.session_label,
    connectorId: row.connector_id,
    codexSessionId: row.codex_session_id,
    method: row.method,
    threadId: row.thread_id,
    turnId: row.turn_id,
    ownerUserId: row.owner_user_id,
    detail: row.detail,
    callbackToken: row.callback_token,
    tokenHash: row.token_hash,
    state: row.state,
    expiresAtMs: row.expires_at_ms,
    deliveredAtMs: row.delivered_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapWake(row) {
  if (!row) return null
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    source: row.source,
    reason: row.reason,
    context: parse(row.context_json),
    dedupeKey: row.dedupe_key,
    earliestAtMs: row.earliest_at_ms,
    expiresAtMs: row.expires_at_ms,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapApprovedChat(row) {
  if (!row) return null
  return {
    conversationKey: row.conversation_key,
    telegramChatId: row.telegram_chat_id,
    alias: row.alias,
    title: row.title,
    kind: row.kind,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    updateId: row.update_id,
    conversationKey: row.conversation_key,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    senderId: row.sender_id,
    messageType: row.message_type,
    metadata: parse(row.metadata_json),
    codexCorrelationId: row.codex_correlation_id,
    createdAtMs: row.created_at_ms,
  }
}

function mapAttachment(row) {
  if (!row) return null
  return {
    id: row.id,
    updateId: row.update_id,
    telegramFileId: row.telegram_file_id,
    telegramUniqueId: row.telegram_unique_id,
    localPath: row.local_path,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAtMs: row.created_at_ms,
  }
}

function mapRelayJob(row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    conversationKey: row.conversation_key,
    sessionLabel: row.session_label,
    payload: parse(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    codexSessionId: row.codex_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    result: parse(row.result_json),
    lastError: row.last_error,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapRelaySession(row) {
  if (!row) return null
  return {
    sessionLabel: row.session_label,
    connectorId: row.connector_id,
    codexSessionId: row.codex_session_id,
    status: row.status,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    offlineEpoch: row.offline_epoch,
    connectedAtMs: row.connected_at_ms,
    disconnectedAtMs: row.disconnected_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

export class StateStore {
  static open(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new Database(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    const store = new StateStore(db)
    store.#initialize()
    return store
  }

  #db
  #closed = false

  constructor(db) {
    this.#db = db
  }

  #initialize() {
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = FULL')
    this.#db.pragma('foreign_keys = ON')
    this.#db.pragma('busy_timeout = 5000')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id TEXT PRIMARY KEY,
        raw_json TEXT NOT NULL,
        normalized_type TEXT NOT NULL,
        conversation_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at_ms INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'unsupported'))
      );
      CREATE INDEX IF NOT EXISTS telegram_updates_pending
        ON telegram_updates(status, available_at_ms, lease_expires_at_ms);

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        thread_id TEXT,
        model_override TEXT,
        effort_override TEXT,
        active_turn_id TEXT,
        active_turn_started_at_ms INTEGER,
        stale_reason TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_active_turn
        ON conversations(active_turn_id) WHERE active_turn_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_thread
        ON conversations(thread_id) WHERE thread_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id TEXT,
        conversation_key TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        sender_id TEXT,
        message_type TEXT NOT NULL,
        metadata_json TEXT,
        codex_correlation_id TEXT,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(telegram_chat_id, telegram_message_id, message_type)
      );

      CREATE TABLE IF NOT EXISTS approved_chats (
        conversation_key TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        alias TEXT UNIQUE,
        title TEXT,
        kind TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_actions (
        action_id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sequence_group TEXT NOT NULL,
        sequence_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        telegram_chat_id TEXT,
        telegram_message_id TEXT,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (status IN ('pending', 'sending', 'sent', 'ambiguous', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS outbound_actions_status
        ON outbound_actions(status, next_attempt_at_ms, sequence_group, sequence_index);

      CREATE TABLE IF NOT EXISTS bot_reaction_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL UNIQUE REFERENCES outbound_actions(action_id),
        conversation_key TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_username TEXT,
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        reaction_json TEXT NOT NULL,
        extends_cooldown INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        CHECK (extends_cooldown IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS bot_reaction_events_cursor
        ON bot_reaction_events(event_id);

      CREATE TABLE IF NOT EXISTS approvals (
        token_hash TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        owner_user_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        response_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (state IN ('pending', 'approved', 'denied', 'expired'))
      );
      CREATE INDEX IF NOT EXISTS approvals_pending
        ON approvals(state, expires_at_ms);

      CREATE TABLE IF NOT EXISTS relay_approvals (
        approval_id TEXT PRIMARY KEY,
        session_label TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        codex_session_id TEXT NOT NULL,
        method TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending',
        expires_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS relay_approvals_delivery
        ON relay_approvals(session_label, codex_session_id, delivered_at_ms, state, updated_at_ms);
      CREATE INDEX IF NOT EXISTS relay_approvals_expiry
        ON relay_approvals(state, expires_at_ms);

      CREATE TABLE IF NOT EXISTS wake_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        context_json TEXT,
        dedupe_key TEXT NOT NULL,
        earliest_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(source, dedupe_key),
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired'))
      );
      CREATE INDEX IF NOT EXISTS wake_requests_due
        ON wake_requests(status, earliest_at_ms, expires_at_ms, lease_expires_at_ms);

      CREATE TABLE IF NOT EXISTS relay_jobs (
        job_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        session_label TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        codex_session_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        result_json TEXT,
        last_error TEXT,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(source_type, source_id),
        CHECK (status IN ('pending', 'leased', 'accepted', 'completed', 'failed', 'expired'))
      );
      CREATE INDEX IF NOT EXISTS relay_jobs_claimable
        ON relay_jobs(session_label, status, expires_at_ms, lease_expires_at_ms, created_at_ms);

      CREATE TABLE IF NOT EXISTS relay_sessions (
        session_label TEXT PRIMARY KEY,
        connector_id TEXT,
        codex_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        lease_expires_at_ms INTEGER,
        offline_epoch INTEGER NOT NULL DEFAULT 1,
        connected_at_ms INTEGER,
        disconnected_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        CHECK (status IN ('online', 'offline'))
      );

      CREATE TABLE IF NOT EXISTS relay_offline_notices (
        session_label TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        offline_epoch INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(session_label, conversation_key, offline_epoch)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id TEXT,
        telegram_file_id TEXT NOT NULL,
        telegram_unique_id TEXT,
        local_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER,
        sha256 TEXT,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(telegram_file_id, local_path)
      );
    `)
    const schemaVersion = this.getSetting('schema_version')
    if (schemaVersion === null || schemaVersion === '1') {
      this.setSetting('schema_version', SCHEMA_VERSION, Date.now())
    } else if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`unsupported state schema version: ${schemaVersion}`)
    }
  }

  pragma(source, options) {
    return this.#db.pragma(source, options)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  getSetting(key) {
    return this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
  }

  setSetting(key, value, nowMs = Date.now()) {
    this.#db.prepare(`
      INSERT INTO settings(key, value, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
    `).run(key, String(value), nowMs)
  }

  deleteSetting(key) {
    return this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes === 1
  }

  getPollOffset() {
    return this.getSetting('telegram_poll_offset')
  }

  storeUpdate({ updateId, raw, normalizedType, conversationKey = null, nowMs = Date.now() }) {
    updateId = requireUpdateId(updateId)
    const transaction = this.#db.transaction(() => {
      const inserted = this.#db.prepare(`
        INSERT OR IGNORE INTO telegram_updates(
          update_id, raw_json, normalized_type, conversation_key, status,
          available_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(updateId, stringify(raw), normalizedType, conversationKey, nowMs, nowMs, nowMs).changes === 1

      const candidate = BigInt(updateId) + 1n
      const currentRaw = this.getPollOffset()
      const current = currentRaw === null ? null : BigInt(currentRaw)
      if (current === null || candidate > current) {
        this.setSetting('telegram_poll_offset', candidate.toString(), nowMs)
      }
      return { inserted, pollOffset: this.getPollOffset() }
    })
    return transaction()
  }

  getUpdate(updateId) {
    return mapUpdate(this.#db.prepare('SELECT * FROM telegram_updates WHERE update_id = ?').get(String(updateId)))
  }

  claimUpdates({ workerId, limit = 1, leaseMs = 120_000, nowMs = Date.now() }) {
    if (!workerId) throw new Error('workerId is required')
    const transaction = this.#db.transaction(() => {
      const rows = this.#db.prepare(`
        SELECT update_id FROM telegram_updates
        WHERE status = 'pending' AND available_at_ms <= ?
        ORDER BY length(update_id), update_id
        LIMIT ?
      `).all(nowMs, limit)
      const update = this.#db.prepare(`
        UPDATE telegram_updates
        SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE update_id = ? AND status = 'pending'
      `)
      for (const row of rows) update.run(workerId, nowMs + leaseMs, nowMs, row.update_id)
      return rows.map(row => this.getUpdate(row.update_id))
    })
    return transaction()
  }

  claimUpdatesMatching({
    workerId,
    predicate,
    scanLimit = 1_024,
    limit = 8,
    leaseMs = 120_000,
    nowMs = Date.now(),
  }) {
    if (!workerId) throw new Error('workerId is required')
    if (typeof predicate !== 'function') throw new Error('predicate is required')
    const transaction = this.#db.transaction(() => {
      const limitClause = scanLimit === null ? '' : 'LIMIT ?'
      if (scanLimit !== null && (!Number.isSafeInteger(scanLimit) || scanLimit < 1)) {
        throw new Error('scanLimit must be null or a positive integer')
      }
      const statement = this.#db.prepare(`
        SELECT update_id FROM telegram_updates
        WHERE status = 'pending' AND available_at_ms <= ?
        ORDER BY length(update_id), update_id
        ${limitClause}
      `)
      const rows = scanLimit === null ? statement.all(nowMs) : statement.all(nowMs, scanLimit)
      const candidates = rows.map(row => this.getUpdate(row.update_id))
      const selected = candidates.filter(predicate).slice(0, limit)
      const claim = this.#db.prepare(`
        UPDATE telegram_updates
        SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE update_id = ? AND status = 'pending'
      `)
      const claimed = []
      for (const row of selected) {
        if (claim.run(workerId, nowMs + leaseMs, nowMs, row.updateId).changes === 1) {
          claimed.push(this.getUpdate(row.updateId))
        }
      }
      return claimed
    })
    return transaction()
  }

  recoverExpiredLeases(nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE telegram_updates
      SET status = 'pending', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE status = 'processing' AND lease_expires_at_ms <= ?
    `).run(nowMs, nowMs).changes
  }

  completeUpdate({ updateId, workerId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE telegram_updates
      SET status = 'completed', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE update_id = ? AND status = 'processing' AND lease_owner = ?
    `).run(nowMs, String(updateId), workerId).changes === 1
  }

  // Returns a claimed update to the queue untouched: no attempt penalty, no
  // error, original availability. Used when a claim was only an inspection
  // (e.g. the away release mention must flow through the normal pipeline).
  releaseUpdate({ updateId, workerId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE telegram_updates
      SET status = 'pending', attempts = MAX(attempts - 1, 0), lease_owner = NULL,
          lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE update_id = ? AND status = 'processing' AND lease_owner = ?
    `).run(nowMs, String(updateId), workerId).changes === 1
  }

  countQueuedUpdates(nowMs = Date.now()) {
    return this.#db.prepare(`
      SELECT COUNT(*) AS count FROM telegram_updates
      WHERE status IN ('pending', 'processing')
    `).get().count
  }

  countActiveRelayJobs(sessionLabel, nowMs = Date.now()) {
    return this.#db.prepare(`
      SELECT COUNT(*) AS count FROM relay_jobs
      WHERE session_label = ? AND status IN ('pending', 'leased') AND expires_at_ms > ?
    `).get(String(sessionLabel), nowMs).count
  }

  countUndeliveredOutboundActions() {
    return this.#db.prepare(`
      SELECT COUNT(*) AS count FROM outbound_actions
      WHERE status IN ('pending', 'sending')
         OR (status = 'failed' AND next_attempt_at_ms IS NOT NULL)
    `).get().count
  }

  failUpdate({ updateId, workerId, error, retryAtMs = Date.now(), permanent = false, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE telegram_updates
      SET status = ?, available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error = ?, updated_at_ms = ?
      WHERE update_id = ? AND status = 'processing' AND lease_owner = ?
    `).run(permanent ? 'failed' : 'pending', retryAtMs, String(error), nowMs, String(updateId), workerId).changes === 1
  }

  failUncertainSource(sourceId, error, nowMs = Date.now()) {
    const telegram = String(sourceId).match(/^telegram:(\d+)$/u)
    if (telegram) {
      return this.#db.prepare(`
        UPDATE telegram_updates
        SET status = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
            last_error = ?, updated_at_ms = ?
        WHERE update_id = ? AND status IN ('pending', 'processing')
      `).run(String(error), nowMs, telegram[1]).changes === 1
    }
    const wake = String(sourceId).match(/^wake:(\d+)$/u)
    if (wake) {
      return this.#db.prepare(`
        UPDATE wake_requests
        SET status = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
            last_error = ?, updated_at_ms = ?
        WHERE id = ? AND status IN ('pending', 'processing')
      `).run(String(error), nowMs, Number(wake[1])).changes === 1
    }
    return false
  }

  upsertConversation({ conversationKey, threadId, modelOverride, effortOverride, nowMs = Date.now() }) {
    const existing = this.getConversation(conversationKey)
    const next = {
      conversationKey,
      threadId: threadId === undefined ? existing?.threadId ?? null : threadId,
      modelOverride: modelOverride === undefined ? existing?.modelOverride ?? null : modelOverride,
      effortOverride: effortOverride === undefined ? existing?.effortOverride ?? null : effortOverride,
      activeTurnId: existing?.activeTurnId ?? null,
      activeTurnStartedAtMs: existing?.activeTurnStartedAtMs ?? null,
      staleReason: threadId === undefined ? existing?.staleReason ?? null : null,
      updatedAtMs: nowMs,
    }
    this.#db.prepare(`
      INSERT INTO conversations(
        conversation_key, thread_id, model_override, effort_override,
        active_turn_id, active_turn_started_at_ms, stale_reason, updated_at_ms
      ) VALUES (@conversationKey, @threadId, @modelOverride, @effortOverride,
                @activeTurnId, @activeTurnStartedAtMs, @staleReason, @updatedAtMs)
      ON CONFLICT(conversation_key) DO UPDATE SET
        thread_id = excluded.thread_id,
        model_override = excluded.model_override,
        effort_override = excluded.effort_override,
        active_turn_id = excluded.active_turn_id,
        active_turn_started_at_ms = excluded.active_turn_started_at_ms,
        stale_reason = excluded.stale_reason,
        updated_at_ms = excluded.updated_at_ms
    `).run(next)
    return this.getConversation(conversationKey)
  }

  getConversation(conversationKey) {
    return mapConversation(this.#db.prepare('SELECT * FROM conversations WHERE conversation_key = ?').get(conversationKey))
  }

  listActiveConversations() {
    return this.#db.prepare(`
      SELECT * FROM conversations
      WHERE thread_id IS NOT NULL AND active_turn_id IS NOT NULL
      ORDER BY conversation_key
    `).all().map(row => {
      const conversation = mapConversation(row)
      return {
        ...conversation,
        activeSourceId: this.getSetting(`active_source:${conversation.conversationKey}`),
      }
    })
  }

  getConversationByThreadId(threadId) {
    return mapConversation(this.#db.prepare('SELECT * FROM conversations WHERE thread_id = ?').get(threadId))
  }

  setActiveTurn({ conversationKey, turnId, nowMs = Date.now() }) {
    return this.beginActiveTurn({ conversationKey, placeholderTurnId: turnId, sourceId: null, nowMs })
  }

  beginActiveTurn({ conversationKey, placeholderTurnId, sourceId = null, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      if (!this.getConversation(conversationKey)) this.upsertConversation({ conversationKey, nowMs })
      const current = this.getConversation(conversationKey)
      if (current.activeTurnId && current.activeTurnId !== placeholderTurnId) {
        throw new Error(`${conversationKey} already has active turn ${current.activeTurnId}`)
      }
      this.#db.prepare(`
        UPDATE conversations
        SET active_turn_id = ?, active_turn_started_at_ms = ?, updated_at_ms = ?
        WHERE conversation_key = ?
      `).run(placeholderTurnId, nowMs, nowMs, conversationKey)
      const sourceKey = `active_source:${conversationKey}`
      if (sourceId === null) this.deleteSetting(sourceKey)
      else this.setSetting(sourceKey, sourceId, nowMs)
      return true
    })
    return transaction()
  }

  replaceActiveTurn({ conversationKey, expectedTurnId, turnId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE conversations
      SET active_turn_id = ?, updated_at_ms = ?
      WHERE conversation_key = ? AND active_turn_id = ?
    `).run(turnId, nowMs, conversationKey, expectedTurnId).changes === 1
  }

  clearActiveTurn({ conversationKey, turnId, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      const cleared = this.#db.prepare(`
        UPDATE conversations
        SET active_turn_id = NULL, active_turn_started_at_ms = NULL, updated_at_ms = ?
        WHERE conversation_key = ? AND active_turn_id = ?
      `).run(nowMs, conversationKey, turnId).changes === 1
      if (cleared) this.deleteSetting(`active_source:${conversationKey}`)
      return cleared
    })
    return transaction()
  }

  detachThread(conversationKey, staleReason = null, nowMs = Date.now()) {
    const current = this.getConversation(conversationKey)
    if (!current) return null
    this.#db.prepare(`
      UPDATE conversations
      SET thread_id = NULL, active_turn_id = NULL, active_turn_started_at_ms = NULL,
          stale_reason = ?, updated_at_ms = ?
      WHERE conversation_key = ?
    `).run(staleReason, nowMs, conversationKey)
    return current.threadId
  }

  upsertApprovedChat({ conversationKey, telegramChatId, alias = null, title = null, kind, nowMs = Date.now() }) {
    this.#db.prepare(`
      INSERT INTO approved_chats(conversation_key, telegram_chat_id, alias, title, kind, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        telegram_chat_id = excluded.telegram_chat_id,
        alias = excluded.alias,
        title = excluded.title,
        kind = excluded.kind,
        updated_at_ms = excluded.updated_at_ms
    `).run(conversationKey, telegramChatId, alias, title, kind, nowMs)
    return this.getApprovedChat(conversationKey)
  }

  replaceApprovedChats(chats, nowMs = Date.now()) {
    const transaction = this.#db.transaction(() => {
      this.#db.prepare('UPDATE approved_chats SET alias = NULL, updated_at_ms = ?').run(nowMs)
      const keys = chats.map(chat => chat.conversationKey)
      if (keys.length === 0) {
        this.#db.prepare('DELETE FROM approved_chats').run()
      } else {
        const placeholders = keys.map(() => '?').join(', ')
        this.#db.prepare(`DELETE FROM approved_chats WHERE conversation_key NOT IN (${placeholders})`).run(...keys)
      }
      for (const chat of chats) this.upsertApprovedChat({ ...chat, nowMs })
      return this.listApprovedChats()
    })
    return transaction()
  }

  getApprovedChat(conversationKey) {
    return mapApprovedChat(this.#db.prepare('SELECT * FROM approved_chats WHERE conversation_key = ?').get(conversationKey))
  }

  getApprovedChatByAlias(alias) {
    return mapApprovedChat(this.#db.prepare('SELECT * FROM approved_chats WHERE alias = ?').get(alias))
  }

  listApprovedChats() {
    return this.#db.prepare('SELECT * FROM approved_chats ORDER BY alias, conversation_key').all().map(mapApprovedChat)
  }

  recordMessage({
    updateId = null,
    conversationKey,
    telegramChatId,
    telegramMessageId,
    senderId = null,
    messageType,
    metadata = null,
    codexCorrelationId = null,
    nowMs = Date.now(),
  }) {
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO messages(
        update_id, conversation_key, telegram_chat_id, telegram_message_id, sender_id,
        message_type, metadata_json, codex_correlation_id, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      updateId,
      conversationKey,
      telegramChatId,
      telegramMessageId,
      senderId,
      messageType,
      stringify(metadata),
      codexCorrelationId,
      nowMs,
    ).changes === 1
    const message = mapMessage(this.#db.prepare(`
      SELECT * FROM messages
      WHERE telegram_chat_id = ? AND telegram_message_id = ? AND message_type = ?
    `).get(telegramChatId, telegramMessageId, messageType))
    return { created, message }
  }

  listMessages(conversationKey, limit = 50) {
    return this.#db.prepare(`
      SELECT * FROM messages WHERE conversation_key = ?
      ORDER BY id DESC LIMIT ?
    `).all(conversationKey, limit).map(mapMessage)
  }

  recordAttachment({
    updateId = null,
    telegramFileId,
    telegramUniqueId = null,
    localPath,
    mediaType,
    byteSize = null,
    sha256 = null,
    nowMs = Date.now(),
  }) {
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO attachments(
        update_id, telegram_file_id, telegram_unique_id, local_path,
        media_type, byte_size, sha256, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      updateId,
      telegramFileId,
      telegramUniqueId,
      localPath,
      mediaType,
      byteSize,
      sha256,
      nowMs,
    ).changes === 1
    return { created, attachment: this.getAttachmentByFileId(telegramFileId) }
  }

  getAttachmentByFileId(telegramFileId) {
    return mapAttachment(this.#db.prepare(`
      SELECT * FROM attachments WHERE telegram_file_id = ? ORDER BY id DESC LIMIT 1
    `).get(telegramFileId))
  }

  createOutboundAction({
    actionId,
    conversationKey,
    actionType,
    payload,
    sequenceGroup = actionId,
    sequenceIndex = 0,
    nowMs = Date.now(),
  }) {
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO outbound_actions(
        action_id, conversation_key, action_type, payload_json, sequence_group,
        sequence_index, status, next_attempt_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      actionId,
      conversationKey,
      actionType,
      stringify(payload),
      sequenceGroup,
      sequenceIndex,
      nowMs,
      nowMs,
      nowMs,
    ).changes === 1
    return { created, action: this.getOutboundAction(actionId) }
  }

  getOutboundAction(actionId) {
    return mapOutbound(this.#db.prepare('SELECT * FROM outbound_actions WHERE action_id = ?').get(actionId))
  }

  markOutboundSending(actionId, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'sending', attempts = attempts + 1, updated_at_ms = ?
      WHERE action_id = ? AND status IN ('pending', 'failed')
        AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?
    `).run(nowMs, actionId, nowMs).changes === 1
  }

  markOutboundSent(actionId, {
    telegramChatId = null,
    telegramMessageId = null,
    result = null,
    botIdentity = null,
  } = {}, nowMs = Date.now()) {
    const transaction = this.#db.transaction(() => {
      const sent = this.#db.prepare(`
        UPDATE outbound_actions
        SET status = 'sent', telegram_chat_id = ?, telegram_message_id = ?, result_json = ?,
            next_attempt_at_ms = NULL, last_error = NULL, updated_at_ms = ?
        WHERE action_id = ? AND status = 'sending'
      `).run(telegramChatId, telegramMessageId, stringify(result), nowMs, actionId).changes === 1
      if (!sent) return false
      const action = this.getOutboundAction(actionId)
      if (action.actionType === 'react' && botIdentity?.id) {
        this.recordBotReactionEvent({
          actionId,
          botId: botIdentity.id,
          botUsername: botIdentity.username ?? null,
          nowMs,
        })
      }
      return true
    })
    return transaction()
  }

  markOutboundAmbiguous(actionId, error, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'ambiguous', next_attempt_at_ms = NULL, last_error = ?, updated_at_ms = ?
      WHERE action_id = ? AND status = 'sending'
    `).run(String(error), nowMs, actionId).changes === 1
  }

  markOutboundFailed(actionId, error, retryAtMs = null, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'failed', next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?
      WHERE action_id = ? AND status = 'sending'
    `).run(retryAtMs, String(error), nowMs, actionId).changes === 1
  }

  supersedeOutboundActions({ actionIds, reason, nowMs = Date.now() }) {
    if (!Array.isArray(actionIds) || new Set(actionIds).size !== actionIds.length) {
      throw new Error('superseded outbound actions require unique action IDs')
    }
    const update = this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'failed', next_attempt_at_ms = NULL, last_error = ?, updated_at_ms = ?
      WHERE action_id = ? AND status IN ('pending', 'failed')
    `)
    const transaction = this.#db.transaction(() => actionIds.reduce(
      (count, actionId) => count + update.run(String(reason), nowMs, String(actionId)).changes,
      0,
    ))
    return transaction()
  }

  recoverInterruptedOutboundActions(nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'ambiguous', next_attempt_at_ms = NULL,
          last_error = 'bridge restart interrupted Telegram delivery; result unknown',
          updated_at_ms = ?
      WHERE status = 'sending'
    `).run(nowMs).changes
  }

  claimDueOutboundActions({ workerId, limit = 1, nowMs = Date.now() }) {
    if (!workerId) throw new Error('workerId is required')
    const transaction = this.#db.transaction(() => {
      const rows = this.#db.prepare(`
        SELECT current.action_id
        FROM outbound_actions AS current
        WHERE current.status IN ('pending', 'failed')
          AND current.next_attempt_at_ms IS NOT NULL
          AND current.next_attempt_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1 FROM outbound_actions AS prior
            WHERE prior.sequence_group = current.sequence_group
              AND prior.sequence_index < current.sequence_index
              AND prior.status != 'sent'
          )
        ORDER BY current.created_at_ms, current.sequence_group, current.sequence_index
        LIMIT ?
      `).all(nowMs, limit)
      const claim = this.#db.prepare(`
        UPDATE outbound_actions
        SET status = 'sending', attempts = attempts + 1, updated_at_ms = ?
        WHERE action_id = ? AND status IN ('pending', 'failed')
          AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?
      `)
      for (const row of rows) claim.run(nowMs, row.action_id, nowMs)
      return rows.map(row => this.getOutboundAction(row.action_id))
    })
    return transaction()
  }

  findSentOutboundMessage(telegramChatId, telegramMessageId) {
    return mapOutbound(this.#db.prepare(`
      SELECT * FROM outbound_actions
      WHERE status = 'sent' AND telegram_chat_id = ? AND telegram_message_id = ?
      ORDER BY updated_at_ms DESC LIMIT 1
    `).get(String(telegramChatId), String(telegramMessageId)))
  }

  recordBotReactionEvent({ actionId, botId, botUsername = null, nowMs = Date.now() }) {
    if (!botId) throw new Error('bot reaction event requires botId')
    const action = this.getOutboundAction(actionId)
    if (!action || action.actionType !== 'react' || action.status !== 'sent') {
      throw new Error('bot reaction event requires a sent reaction action')
    }
    const { chatId, messageId, reaction } = action.payload ?? {}
    if (!chatId || !messageId || !reaction) throw new Error('sent reaction action is missing event context')
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO bot_reaction_events(
        action_id, conversation_key, bot_id, bot_username, telegram_chat_id,
        telegram_message_id, reaction_json, extends_cooldown, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      String(actionId),
      action.conversationKey,
      String(botId),
      botUsername === null || botUsername === undefined ? null : String(botUsername),
      String(chatId),
      String(messageId),
      stringify(reaction),
      nowMs,
    ).changes === 1
    return {
      created,
      event: mapBotReactionEvent(this.#db.prepare(`
        SELECT * FROM bot_reaction_events WHERE action_id = ?
      `).get(String(actionId))),
    }
  }

  listBotReactionEvents({ afterEventId = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      throw new Error('afterEventId must be a non-negative integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('bot reaction event limit must be between 1 and 1000')
    }
    return this.#db.prepare(`
      SELECT * FROM bot_reaction_events
      WHERE event_id > ?
      ORDER BY event_id
      LIMIT ?
    `).all(afterEventId, limit).map(mapBotReactionEvent)
  }

  createApproval({
    tokenHash,
    requestId,
    method,
    conversationKey,
    threadId = null,
    turnId = null,
    ownerUserId,
    expiresAtMs,
    nowMs = Date.now(),
  }) {
    this.#db.prepare(`
      INSERT INTO approvals(
        token_hash, request_id, method, conversation_key, thread_id, turn_id,
        owner_user_id, expires_at_ms, state, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(tokenHash, requestId, method, conversationKey, threadId, turnId, ownerUserId, expiresAtMs, nowMs, nowMs)
    return this.getApproval(tokenHash)
  }

  getApproval(tokenHash) {
    return mapApproval(this.#db.prepare('SELECT * FROM approvals WHERE token_hash = ?').get(tokenHash))
  }

  expirePendingApprovals(nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE approvals SET state = 'expired', updated_at_ms = ?
      WHERE state = 'pending'
    `).run(nowMs).changes
  }

  resolveApproval({ tokenHash, ownerUserId, decision, response = null, nowMs = Date.now() }) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('approval decision must be approved or denied')
    const transaction = this.#db.transaction(() => {
      const approval = this.getApproval(tokenHash)
      if (!approval) return { resolved: false, reason: 'not_found' }
      if (approval.ownerUserId !== ownerUserId) return { resolved: false, reason: 'owner_mismatch' }
      if (approval.state !== 'pending') return { resolved: false, reason: 'already_resolved' }
      if (nowMs >= approval.expiresAtMs) {
        this.#db.prepare(`
          UPDATE approvals SET state = 'expired', updated_at_ms = ?
          WHERE token_hash = ? AND state = 'pending'
        `).run(nowMs, tokenHash)
        return { resolved: false, reason: 'expired' }
      }
      this.#db.prepare(`
        UPDATE approvals SET state = ?, response_json = ?, updated_at_ms = ?
        WHERE token_hash = ? AND state = 'pending'
      `).run(decision, stringify(response), nowMs, tokenHash)
      return { resolved: true, approval: this.getApproval(tokenHash) }
    })
    return transaction()
  }

  createRelayApproval({
    approvalId,
    sessionLabel,
    connectorId,
    codexSessionId,
    method,
    threadId,
    turnId,
    ownerUserId,
    detail,
    callbackToken,
    tokenHash,
    expiresAtMs,
    nowMs = Date.now(),
  }) {
    if (!approvalId || !sessionLabel || !connectorId || !codexSessionId || !method || !threadId || !turnId || !ownerUserId || !callbackToken || !tokenHash) {
      throw new Error('relay approval identity fields are required')
    }
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new Error('relay approval expiry must be after creation')
    }
    this.#db.prepare(`
      INSERT OR IGNORE INTO relay_approvals(
        approval_id, session_label, connector_id, codex_session_id, method, thread_id, turn_id,
        owner_user_id, detail, callback_token, token_hash, state, expires_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      approvalId,
      sessionLabel,
      connectorId,
      codexSessionId,
      method,
      threadId,
      turnId,
      ownerUserId,
      detail,
      callbackToken,
      tokenHash,
      expiresAtMs,
      nowMs,
      nowMs,
    )
    return this.getRelayApproval(approvalId)
  }

  getRelayApproval(approvalId) {
    return mapRelayApproval(this.#db.prepare(
      'SELECT * FROM relay_approvals WHERE approval_id = ?',
    ).get(approvalId))
  }

  rebindRelayApproval({ approvalId, connectorId, nowMs = Date.now() }) {
    if (!approvalId || !connectorId) throw new Error('relay approval rebind identity is required')
    this.#db.prepare(`
      UPDATE relay_approvals
      SET connector_id = ?,
          delivered_at_ms = CASE
            WHEN state IN ('approved', 'denied', 'expired') THEN NULL
            ELSE delivered_at_ms
          END,
          updated_at_ms = ?
      WHERE approval_id = ? AND connector_id != ? AND state != 'cancelled'
    `).run(connectorId, nowMs, approvalId, connectorId)
    return this.getRelayApproval(approvalId)
  }

  resolveRelayApproval({ tokenHash, ownerUserId, decision, nowMs = Date.now() }) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('relay approval decision must be approved or denied')
    const transaction = this.#db.transaction(() => {
      const approval = mapRelayApproval(this.#db.prepare(
        'SELECT * FROM relay_approvals WHERE token_hash = ?',
      ).get(tokenHash))
      if (!approval) return { resolved: false, reason: 'not_found' }
      if (approval.ownerUserId !== ownerUserId) return { resolved: false, reason: 'owner_mismatch' }
      if (approval.state !== 'pending') return { resolved: false, reason: 'already_resolved' }
      if (nowMs >= approval.expiresAtMs) {
        this.#db.prepare(`
          UPDATE relay_approvals SET state = 'expired', updated_at_ms = ?
          WHERE approval_id = ? AND state = 'pending'
        `).run(nowMs, approval.approvalId)
        return { resolved: false, reason: 'expired' }
      }
      this.#db.prepare(`
        UPDATE relay_approvals SET state = ?, updated_at_ms = ?
        WHERE approval_id = ? AND state = 'pending'
      `).run(decision, nowMs, approval.approvalId)
      return { resolved: true, approval: this.getRelayApproval(approval.approvalId) }
    })
    return transaction()
  }

  cancelRelayApproval(approvalId, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE relay_approvals SET state = 'cancelled', updated_at_ms = ?
      WHERE approval_id = ? AND delivered_at_ms IS NULL AND state != 'cancelled'
    `).run(nowMs, approvalId).changes === 1
  }

  expireRelayApprovals(nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE relay_approvals SET state = 'expired', updated_at_ms = ?
      WHERE state = 'pending' AND expires_at_ms <= ?
    `).run(nowMs, nowMs).changes
  }

  nextRelayApprovalResponse({ sessionLabel, codexSessionId, nowMs = Date.now() }) {
    this.expireRelayApprovals(nowMs)
    return mapRelayApproval(this.#db.prepare(`
      SELECT * FROM relay_approvals
      WHERE session_label = ? AND codex_session_id = ?
        AND delivered_at_ms IS NULL
        AND state IN ('approved', 'denied', 'expired')
      ORDER BY updated_at_ms, created_at_ms
      LIMIT 1
    `).get(sessionLabel, codexSessionId))
  }

  markRelayApprovalDelivered(approvalId, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE relay_approvals SET delivered_at_ms = ?, updated_at_ms = ?
      WHERE approval_id = ? AND delivered_at_ms IS NULL
        AND state IN ('approved', 'denied', 'expired')
    `).run(nowMs, nowMs, approvalId).changes === 1
  }

  enqueueRelayJob({
    jobId,
    sourceType,
    sourceId,
    conversationKey,
    sessionLabel,
    payload,
    expiresAtMs,
    nowMs = Date.now(),
  }) {
    if (!jobId || !sourceType || !sourceId || !conversationKey || !sessionLabel) {
      throw new Error('relay job identity fields are required')
    }
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new Error('relay job expiry must be after creation')
    }
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO relay_jobs(
        job_id, source_type, source_id, conversation_key, session_label,
        payload_json, status, expires_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      String(jobId),
      String(sourceType),
      String(sourceId),
      String(conversationKey),
      String(sessionLabel),
      stringify(payload),
      expiresAtMs,
      nowMs,
      nowMs,
    ).changes === 1
    return { created, job: this.getRelayJob(jobId) }
  }

  getRelayJob(jobId) {
    return mapRelayJob(this.#db.prepare('SELECT * FROM relay_jobs WHERE job_id = ?').get(String(jobId)))
  }

  expireRelayJobs(nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE relay_jobs
      SET status = 'expired', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE
        (status = 'pending' AND expires_at_ms <= ?)
        OR
        (status = 'leased' AND lease_expires_at_ms <= ? AND expires_at_ms <= ?)
    `).run(nowMs, nowMs, nowMs, nowMs).changes
  }

  claimRelayJobs({
    sessionLabel,
    connectorId,
    limit = 1,
    leaseMs = 120_000,
    nowMs = Date.now(),
  }) {
    if (!sessionLabel || !connectorId) throw new Error('relay sessionLabel and connectorId are required')
    const transaction = this.#db.transaction(() => {
      this.expireRelayJobs(nowMs)
      this.#db.prepare(`
        UPDATE relay_jobs
        SET status = 'pending', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE status = 'leased' AND lease_expires_at_ms <= ? AND expires_at_ms > ?
      `).run(nowMs, nowMs, nowMs)
      const rows = this.#db.prepare(`
        SELECT job_id FROM relay_jobs
        WHERE session_label = ? AND status = 'pending' AND expires_at_ms > ?
        ORDER BY created_at_ms, job_id
        LIMIT ?
      `).all(String(sessionLabel), nowMs, limit)
      const claim = this.#db.prepare(`
        UPDATE relay_jobs
        SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = 'pending' AND expires_at_ms > ?
      `)
      const claimed = []
      for (const row of rows) {
        if (claim.run(connectorId, nowMs + leaseMs, nowMs, row.job_id, nowMs).changes === 1) {
          claimed.push(this.getRelayJob(row.job_id))
        }
      }
      return claimed
    })
    return transaction()
  }

  claimRelayJobBatch({
    sessionLabel,
    connectorId,
    maxBatchBytes,
    leaseMs = 120_000,
    nowMs = Date.now(),
    coalesceQuietMs = 0,
    coalesceMaxMs = 0,
    allowAttachments = true,
  }) {
    if (!sessionLabel || !connectorId) throw new Error('relay sessionLabel and connectorId are required')
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes <= 0) {
      throw new Error('relay maxBatchBytes must be a positive integer')
    }
    if (!Number.isSafeInteger(coalesceQuietMs) || coalesceQuietMs < 0) {
      throw new Error('relay coalesceQuietMs must be a non-negative integer')
    }
    if (!Number.isSafeInteger(coalesceMaxMs) || coalesceMaxMs < coalesceQuietMs) {
      throw new Error('relay coalesceMaxMs must be an integer at least coalesceQuietMs')
    }
    const transaction = this.#db.transaction(() => {
      this.expireRelayJobs(nowMs)
      this.#db.prepare(`
        UPDATE relay_jobs
        SET status = 'pending', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE status = 'leased' AND lease_expires_at_ms <= ? AND expires_at_ms > ?
      `).run(nowMs, nowMs, nowMs)
      const coalescingEnabled = coalesceQuietMs > 0
      const readyConversations = this.#db.prepare(`
        SELECT * FROM (
          SELECT
            conversation_key,
            MIN(created_at_ms) AS first_created_at_ms,
            MAX(created_at_ms) AS last_created_at_ms,
            MAX(CASE
              WHEN json_extract(payload_json, '$.dispatch.bypassCoalesce') = 1 THEN 1
              ELSE 0
            END) AS bypass_coalesce,
            MAX(CASE
              WHEN json_type(payload_json, '$.attachments') = 'array'
                AND json_array_length(payload_json, '$.attachments') > 0 THEN 1
              ELSE 0
            END) AS has_attachments
          FROM relay_jobs
          WHERE session_label = ? AND status = 'pending' AND expires_at_ms > ?
          GROUP BY conversation_key
        )
        WHERE (? = 1 OR has_attachments = 0)
        ORDER BY bypass_coalesce DESC, first_created_at_ms, conversation_key
      `).all(
        String(sessionLabel),
        nowMs,
        allowAttachments ? 1 : 0,
      )
      if (readyConversations.length === 0) return []

      const bypassing = readyConversations[0].bypass_coalesce === 1
      if (coalescingEnabled && !bypassing) {
        const firstCreatedAtMs = Math.min(...readyConversations.map(row => row.first_created_at_ms))
        const lastCreatedAtMs = Math.max(...readyConversations.map(row => row.last_created_at_ms))
        if (
          lastCreatedAtMs > nowMs - coalesceQuietMs
          && firstCreatedAtMs > nowMs - coalesceMaxMs
        ) return []
      }

      // Controls remain latency-sensitive and isolated. Normal ready
      // conversations contribute their complete pending backlog so messages
      // accumulated while Codex was busy arrive in one turn.
      const conversations = bypassing
        ? [readyConversations[0]]
        : readyConversations

      const conversationJobs = this.#db.prepare(`
        SELECT * FROM relay_jobs
        WHERE session_label = ? AND conversation_key = ?
          AND status = 'pending' AND expires_at_ms > ?
        ORDER BY created_at_ms, job_id
      `)
      const candidates = []
      for (const conversation of conversations) {
        const jobs = conversationJobs
          .all(String(sessionLabel), conversation.conversation_key, nowMs)
          .map(mapRelayJob)
        if (bypassing) {
          const control = jobs.find(job => job.payload?.dispatch?.bypassCoalesce === true)
          if (!control) throw new Error('bypass conversation is missing its control job')
          candidates.push(control)
          continue
        }
        candidates.push(...jobs)
      }
      candidates.sort((left, right) => (
        left.createdAtMs - right.createdAtMs
        || left.jobId.localeCompare(right.jobId)
      ))
      const selected = []
      let usedBytes = 2
      for (const job of candidates) {
        const jobBytes = Buffer.byteLength(JSON.stringify(job)) + (selected.length === 0 ? 0 : 1)
        if (usedBytes + jobBytes > maxBatchBytes) break
        selected.push(job)
        usedBytes += jobBytes
      }
      if (selected.length === 0) throw new Error('oldest relay job exceeds the frame byte limit')

      const claim = this.#db.prepare(`
        UPDATE relay_jobs
        SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE job_id = ? AND status = 'pending' AND expires_at_ms > ?
      `)
      for (const job of selected) {
        if (claim.run(connectorId, nowMs + leaseMs, nowMs, job.jobId, nowMs).changes !== 1) {
          throw new Error(`failed to claim relay batch job ${job.jobId}`)
        }
      }
      return selected.map(job => this.getRelayJob(job.jobId))
    })
    return transaction()
  }

  acceptRelayJob({
    jobId,
    connectorId,
    codexSessionId,
    threadId,
    turnId,
    nowMs = Date.now(),
  }) {
    if (!codexSessionId || !threadId || !turnId) throw new Error('accepted relay job requires Codex identifiers')
    return this.#db.prepare(`
      UPDATE relay_jobs
      SET status = 'accepted', codex_session_id = ?, thread_id = ?, turn_id = ?,
          lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(
      String(codexSessionId),
      String(threadId),
      String(turnId),
      nowMs,
      String(jobId),
      String(connectorId),
    ).changes === 1
  }

  acceptRelayJobBatch({
    jobIds,
    connectorId,
    codexSessionId,
    threadId,
    turnId,
    nowMs = Date.now(),
  }) {
    if (!Array.isArray(jobIds) || jobIds.length === 0 || new Set(jobIds).size !== jobIds.length) {
      throw new Error('accepted relay batch requires unique job IDs')
    }
    if (!codexSessionId || !threadId || !turnId) throw new Error('accepted relay batch requires Codex identifiers')
    const transaction = this.#db.transaction(() => {
      const accept = this.#db.prepare(`
        UPDATE relay_jobs
        SET status = 'accepted', codex_session_id = ?, thread_id = ?, turn_id = ?,
            lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
      `)
      for (const jobId of jobIds) {
        if (accept.run(
          String(codexSessionId),
          String(threadId),
          String(turnId),
          nowMs,
          String(jobId),
          String(connectorId),
        ).changes !== 1) throw new Error('relay batch could not be accepted atomically')
      }
      return true
    })
    try {
      return transaction()
    } catch {
      return false
    }
  }

  releaseRelayJob({ jobId, connectorId, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      const released = this.#db.prepare(`
        UPDATE relay_jobs
        SET status = CASE WHEN expires_at_ms <= ? THEN 'expired' ELSE 'pending' END,
            lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
      `).run(nowMs, nowMs, String(jobId), String(connectorId)).changes === 1
      return released
    })
    return transaction()
  }

  releaseRelayJobBatch({ jobIds, connectorId, nowMs = Date.now() }) {
    if (!Array.isArray(jobIds) || jobIds.length === 0 || new Set(jobIds).size !== jobIds.length) {
      throw new Error('released relay batch requires unique job IDs')
    }
    const transaction = this.#db.transaction(() => {
      const release = this.#db.prepare(`
        UPDATE relay_jobs
        SET status = CASE WHEN expires_at_ms <= ? THEN 'expired' ELSE 'pending' END,
            lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
      `)
      for (const jobId of jobIds) {
        if (release.run(nowMs, nowMs, String(jobId), String(connectorId)).changes !== 1) {
          throw new Error('relay batch could not be released atomically')
        }
      }
      return true
    })
    try {
      return transaction()
    } catch {
      return false
    }
  }

  completeRelayJob({ jobId, turnId, result, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE relay_jobs
      SET status = 'completed', result_json = ?, updated_at_ms = ?
      WHERE job_id = ? AND status = 'accepted' AND turn_id = ?
    `).run(stringify(result), nowMs, String(jobId), String(turnId)).changes === 1
  }

  finalizeRelayJob({ jobId, turnId, result, outboundActions = [], nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      if (!this.completeRelayJob({ jobId, turnId, result, nowMs })) return false
      for (const action of outboundActions) this.createOutboundAction({ ...action, nowMs })
      return true
    })
    return transaction()
  }

  finalizeRelayJobBatch({
    jobIds,
    turnId,
    result,
    outboundActions = [],
    supersedeActionIds = [],
    nowMs = Date.now(),
  }) {
    if (!Array.isArray(jobIds) || jobIds.length === 0 || new Set(jobIds).size !== jobIds.length) {
      throw new Error('finalized relay batch requires unique job IDs')
    }
    const transaction = this.#db.transaction(() => {
      for (const jobId of jobIds) {
        if (!this.completeRelayJob({ jobId, turnId, result, nowMs })) {
          throw new Error('relay batch could not be finalized atomically')
        }
      }
      this.supersedeOutboundActions({
        actionIds: supersedeActionIds,
        reason: 'superseded by final relay result',
        nowMs,
      })
      for (const action of outboundActions) this.createOutboundAction({ ...action, nowMs })
      return true
    })
    try {
      return transaction()
    } catch {
      return false
    }
  }

  failRelayJob({ jobId, error, connectorId = null, turnId = null, nowMs = Date.now() }) {
    const leased = connectorId === null ? 0 : this.#db.prepare(`
      UPDATE relay_jobs
      SET status = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error = ?, updated_at_ms = ?
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(String(error), nowMs, String(jobId), String(connectorId)).changes
    if (leased === 1) return true
    if (turnId === null) return false
    return this.#db.prepare(`
      UPDATE relay_jobs
      SET status = 'failed', last_error = ?, updated_at_ms = ?
      WHERE job_id = ? AND status = 'accepted' AND turn_id = ?
    `).run(String(error), nowMs, String(jobId), String(turnId)).changes === 1
  }

  failRelayJobBatch({ jobIds, error, connectorId = null, turnId = null, nowMs = Date.now() }) {
    if (!Array.isArray(jobIds) || jobIds.length === 0 || new Set(jobIds).size !== jobIds.length) {
      throw new Error('failed relay batch requires unique job IDs')
    }
    const transaction = this.#db.transaction(() => {
      for (const jobId of jobIds) {
        if (!this.failRelayJob({ jobId, error, connectorId, turnId, nowMs })) {
          throw new Error('relay batch could not be failed atomically')
        }
      }
      return true
    })
    try {
      return transaction()
    } catch {
      return false
    }
  }

  ensureRelaySession(sessionLabel, nowMs = Date.now()) {
    this.#db.prepare(`
      INSERT OR IGNORE INTO relay_sessions(
        session_label, status, offline_epoch, updated_at_ms
      ) VALUES (?, 'offline', 1, ?)
    `).run(String(sessionLabel), nowMs)
    return this.getRelaySession(sessionLabel, nowMs)
  }

  getRelaySession(sessionLabel, nowMs = Date.now()) {
    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`
        UPDATE relay_sessions
        SET status = 'offline', connector_id = NULL, lease_expires_at_ms = NULL,
            offline_epoch = offline_epoch + 1, disconnected_at_ms = ?, updated_at_ms = ?
        WHERE session_label = ? AND status = 'online' AND lease_expires_at_ms <= ?
      `).run(nowMs, nowMs, String(sessionLabel), nowMs)
      return mapRelaySession(this.#db.prepare(
        'SELECT * FROM relay_sessions WHERE session_label = ?',
      ).get(String(sessionLabel)))
    })
    return transaction()
  }

  registerRelaySession({
    sessionLabel,
    connectorId,
    codexSessionId,
    leaseMs = 20_000,
    nowMs = Date.now(),
  }) {
    if (!sessionLabel || !connectorId || !codexSessionId) {
      throw new Error('relay registration fields are required')
    }
    const transaction = this.#db.transaction(() => {
      this.ensureRelaySession(sessionLabel, nowMs)
      const current = this.getRelaySession(sessionLabel, nowMs)
      if (current.status === 'online' && current.connectorId !== connectorId) {
        return { registered: false, reason: 'already_connected', session: current }
      }
      this.#db.prepare(`
        UPDATE relay_sessions
        SET connector_id = ?, codex_session_id = ?, status = 'online',
            lease_expires_at_ms = ?, connected_at_ms = ?, disconnected_at_ms = NULL,
            updated_at_ms = ?
        WHERE session_label = ?
      `).run(
        String(connectorId),
        String(codexSessionId),
        nowMs + leaseMs,
        nowMs,
        nowMs,
        String(sessionLabel),
      )
      return { registered: true, session: this.getRelaySession(sessionLabel, nowMs) }
    })
    return transaction()
  }

  heartbeatRelaySession({ sessionLabel, connectorId, leaseMs = 20_000, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE relay_sessions SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE session_label = ? AND connector_id = ? AND status = 'online'
    `).run(nowMs + leaseMs, nowMs, String(sessionLabel), String(connectorId)).changes === 1
  }

  disconnectRelaySession({ sessionLabel, connectorId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE relay_sessions
      SET status = 'offline', connector_id = NULL, lease_expires_at_ms = NULL,
          offline_epoch = offline_epoch + 1, disconnected_at_ms = ?, updated_at_ms = ?
      WHERE session_label = ? AND connector_id = ? AND status = 'online'
    `).run(nowMs, nowMs, String(sessionLabel), String(connectorId)).changes === 1
  }

  claimOfflineNotice({ sessionLabel, conversationKey, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      const session = this.ensureRelaySession(sessionLabel, nowMs)
      if (session.status !== 'offline') return false
      return this.#db.prepare(`
        INSERT OR IGNORE INTO relay_offline_notices(
          session_label, conversation_key, offline_epoch, created_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(
        String(sessionLabel),
        String(conversationKey),
        session.offlineEpoch,
        nowMs,
      ).changes === 1
    })
    return transaction()
  }

  enqueueWake({
    conversationKey,
    source,
    reason,
    context = null,
    dedupeKey,
    earliestAtMs,
    expiresAtMs,
    nowMs = Date.now(),
  }) {
    if (expiresAtMs <= earliestAtMs) throw new Error('wake expiry must be after earliest execution')
    const created = this.#db.prepare(`
      INSERT OR IGNORE INTO wake_requests(
        conversation_key, source, reason, context_json, dedupe_key,
        earliest_at_ms, expires_at_ms, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      conversationKey,
      source,
      reason,
      stringify(context),
      dedupeKey,
      earliestAtMs,
      expiresAtMs,
      nowMs,
      nowMs,
    ).changes === 1
    return { created, wake: this.getWakeByDedupe(source, dedupeKey) }
  }

  getWake(id) {
    return mapWake(this.#db.prepare('SELECT * FROM wake_requests WHERE id = ?').get(id))
  }

  getWakeByDedupe(source, dedupeKey) {
    return mapWake(this.#db.prepare('SELECT * FROM wake_requests WHERE source = ? AND dedupe_key = ?').get(source, dedupeKey))
  }

  claimWakes({ workerId, limit = 1, leaseMs = 120_000, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`
        UPDATE wake_requests SET status = 'expired', lease_owner = NULL,
          lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE status IN ('pending', 'processing') AND expires_at_ms <= ?
      `).run(nowMs, nowMs)
      this.#db.prepare(`
        UPDATE wake_requests SET status = 'pending', lease_owner = NULL,
          lease_expires_at_ms = NULL, updated_at_ms = ?
        WHERE status = 'processing' AND lease_expires_at_ms <= ? AND expires_at_ms > ?
      `).run(nowMs, nowMs, nowMs)
      const rows = this.#db.prepare(`
        SELECT id FROM wake_requests
        WHERE status = 'pending' AND earliest_at_ms <= ? AND expires_at_ms > ?
        ORDER BY earliest_at_ms, id LIMIT ?
      `).all(nowMs, nowMs, limit)
      const claim = this.#db.prepare(`
        UPDATE wake_requests SET status = 'processing', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'pending'
      `)
      for (const row of rows) claim.run(workerId, nowMs + leaseMs, nowMs, row.id)
      return rows.map(row => this.getWake(row.id))
    })
    return transaction()
  }

  completeWake({ id, workerId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE wake_requests
      SET status = 'completed', lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(nowMs, id, workerId).changes === 1
  }

  failWake({ id, workerId, error, retryAtMs = Date.now(), permanent = false, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE wake_requests
      SET status = ?, earliest_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(permanent ? 'failed' : 'pending', retryAtMs, String(error), nowMs, id, workerId).changes === 1
  }
}
