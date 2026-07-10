import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = '1'

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
    if (this.getSetting('schema_version') === null) {
      this.setSetting('schema_version', SCHEMA_VERSION, Date.now())
    } else if (this.getSetting('schema_version') !== SCHEMA_VERSION) {
      throw new Error(`unsupported state schema version: ${this.getSetting('schema_version')}`)
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

  failUpdate({ updateId, workerId, error, retryAtMs = Date.now(), permanent = false, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE telegram_updates
      SET status = ?, available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
          last_error = ?, updated_at_ms = ?
      WHERE update_id = ? AND status = 'processing' AND lease_owner = ?
    `).run(permanent ? 'failed' : 'pending', retryAtMs, String(error), nowMs, String(updateId), workerId).changes === 1
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

  getConversationByThreadId(threadId) {
    return mapConversation(this.#db.prepare('SELECT * FROM conversations WHERE thread_id = ?').get(threadId))
  }

  setActiveTurn({ conversationKey, turnId, nowMs = Date.now() }) {
    const transaction = this.#db.transaction(() => {
      if (!this.getConversation(conversationKey)) this.upsertConversation({ conversationKey, nowMs })
      const current = this.getConversation(conversationKey)
      if (current.activeTurnId && current.activeTurnId !== turnId) {
        throw new Error(`${conversationKey} already has active turn ${current.activeTurnId}`)
      }
      this.#db.prepare(`
        UPDATE conversations
        SET active_turn_id = ?, active_turn_started_at_ms = ?, updated_at_ms = ?
        WHERE conversation_key = ?
      `).run(turnId, nowMs, nowMs, conversationKey)
      return true
    })
    return transaction()
  }

  clearActiveTurn({ conversationKey, turnId, nowMs = Date.now() }) {
    return this.#db.prepare(`
      UPDATE conversations
      SET active_turn_id = NULL, active_turn_started_at_ms = NULL, updated_at_ms = ?
      WHERE conversation_key = ? AND active_turn_id = ?
    `).run(nowMs, conversationKey, turnId).changes === 1
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

  markOutboundSent(actionId, { telegramChatId = null, telegramMessageId = null, result = null } = {}, nowMs = Date.now()) {
    return this.#db.prepare(`
      UPDATE outbound_actions
      SET status = 'sent', telegram_chat_id = ?, telegram_message_id = ?, result_json = ?,
          next_attempt_at_ms = NULL, last_error = NULL, updated_at_ms = ?
      WHERE action_id = ? AND status = 'sending'
    `).run(telegramChatId, telegramMessageId, stringify(result), nowMs, actionId).changes === 1
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
