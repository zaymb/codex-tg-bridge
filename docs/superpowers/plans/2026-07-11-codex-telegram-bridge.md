# Codex Telegram Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, deploy, and verify an always-on Telegram bridge that maps approved Telegram conversation surfaces to durable Codex app-server threads while keeping the Telegram token outside the Codex Unix user boundary.

**Architecture:** A token-holding `tgbridge` service long-polls Telegram, persists accepted work in SQLite, and talks to a separate `codexbot` app-server over a filesystem-protected Unix WebSocket. A narrow control socket handles Telegram actions requested by a local MCP server, while a separate wake socket is reserved for future cron/SW callers.

**Tech Stack:** Node.js 24 LTS for production, ESM, `better-sqlite3@12.11.1`, `ws@8.21.0`, `@modelcontextprotocol/sdk@1.29.0`, Node test runner, Telegram Bot API, Codex app-server protocol from `codex-cli 0.143.0`, systemd.

**Status (2026-07-11):** Tasks 1-7 are implemented, pushed, and locally verified with 156 passing tests plus a real `codex-cli 0.143.0` final-answer and exact-interrupt smoke. Virginia now has 4 GiB swap, Node.js 24.18.0, Codex CLI 0.143.0, deployed schema contract, protected paths, and disabled/inactive systemd units. Codex login, a new independent bot credential, service activation, and real Telegram acceptance remain open.

## Global Constraints

- The bridge uses a new Telegram bot token and must never share a poller with Laurie/Claude Code.
- The production Telegram token is read only by `tgbridge`; the `codexbot` service cannot read its file or environment.
- SQLite WAL state is authoritative for inbound updates, mappings, approvals, outbound ambiguity, and wake requests.
- One conversation key has one serialized active turn; different keys may run concurrently up to a configured global limit.
- Telegram output contains final answers only. Streaming, reasoning deltas, and tool progress are never sent.
- Group turns are read-only. Owner DM turns use workspace-write with on-request approval.
- Cron and SW scheduling are out of scope, but their durable wake-control endpoint is in scope.
- The cooldown simulation remains separate from the production bridge engagement adapter.
- All identifiers are stored and compared as decimal strings so Telegram 64-bit IDs are not rounded by JavaScript.
- The checked contract fixture is generated from the exact deployment Codex CLI and startup fails on an incompatible required method surface.

---

### Task 1: Package, Configuration, Redaction, and Protocol Fixture

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/package-lock.json`
- Create: `bridge/.env.example`
- Create: `bridge/src/config.mjs`
- Create: `bridge/src/redact.mjs`
- Create: `bridge/test/config.test.mjs`
- Create: `bridge/test/redact.test.mjs`
- Create: `bridge/scripts/capture-codex-contract.mjs`
- Create: `bridge/fixtures/codex-app-server-0.143.0/contract.json`

**Interfaces:**
- Produces: `loadConfig(env, filesystem?) -> BridgeConfig` with string Telegram IDs, absolute paths, Sets for allowlists, and no secret-bearing `toJSON` surface.
- Produces: `redact(value, secrets?) -> value` and `redactError(error, secrets?) -> Error`.
- Produces: a contract fixture containing CLI version, required client methods, required server approval methods, required notifications, and SHA-256 hashes of their generated schemas.

- [ ] **Step 1: Write failing config and redaction tests**

Cover missing owner/token/socket paths, non-absolute paths, malformed decimal IDs, defaults, CSV normalization, production token-file preference, Bot API URL redaction, callback-token redaction, and recursive object redaction.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd bridge && node --test test/config.test.mjs test/redact.test.mjs`

Expected: FAIL because `src/config.mjs` and `src/redact.mjs` do not exist.

- [ ] **Step 3: Implement minimal configuration and redaction modules**

The config object must expose `readTelegramToken()` as a closure rather than storing the token in enumerable fields. Production requires `TELEGRAM_TOKEN_FILE`; `TELEGRAM_BOT_TOKEN` is accepted only when `BRIDGE_ALLOW_TOKEN_ENV=true` for local tests.

- [ ] **Step 4: Capture the current app-server contract**

Run:

```bash
codex app-server generate-json-schema --experimental --out /tmp/tg-engage-codex-schema
node bridge/scripts/capture-codex-contract.mjs \
  --schema-dir /tmp/tg-engage-codex-schema \
  --codex-version "$(codex --version)" \
  --out bridge/fixtures/codex-app-server-0.143.0/contract.json
```

The capture script must fail when any required schema file is absent.

- [ ] **Step 5: Run tests and commit**

Run: `cd bridge && npm test`

Commit: `feat(bridge): add configuration and protocol contract`

### Task 2: Durable SQLite State

**Files:**
- Create: `bridge/src/state-store.mjs`
- Create: `bridge/test/state-store.test.mjs`

**Interfaces:**
- Produces: `StateStore.open(path, options?)`.
- Produces update methods `storeUpdate`, `claimUpdates`, `completeUpdate`, `failUpdate`, `recoverExpiredLeases`, and `getPollOffset`.
- Produces conversation methods `getConversation`, `upsertConversation`, `detachThread`, `setActiveTurn`, and `clearActiveTurn`.
- Produces outbound, approval, chat, attachment, and wake ledger methods used by later tasks.

- [ ] **Step 1: Write failing migration and update-ingestion tests**

Verify WAL mode, schema version, duplicate `update_id` no-op behavior, transactional offset advancement only after insert, unknown update retention, and string ID fidelity.

- [ ] **Step 2: Verify RED**

Run: `cd bridge && node --test test/state-store.test.mjs`

- [ ] **Step 3: Implement migrations and ingestion**

Required tables are `telegram_updates`, `conversations`, `messages`, `approved_chats`, `outbound_actions`, `approvals`, `wake_requests`, `attachments`, and `settings`. Add indexes for pending leases, active turns, unresolved approvals, and due wakes.

- [ ] **Step 4: Add failing lease, conversation, approval, outbound, and wake tests**

Verify lease recovery after expiry, attempt counters, exact-turn clearing, topic isolation, callback expiry, single resolution, deterministic outbound IDs, ambiguous state, duplicate suppression, wake dedupe keys, earliest execution, and expiry.

- [ ] **Step 5: Implement the remaining state methods and verify GREEN**

Run: `cd bridge && node --test test/state-store.test.mjs`

Commit: `feat(bridge): add durable sqlite state`

### Task 3: Telegram Transport Surface

**Files:**
- Create: `bridge/src/update-normalizer.mjs`
- Create: `bridge/src/message-format.mjs`
- Create: `bridge/src/attachment-store.mjs`
- Create: `bridge/src/telegram-client.mjs`
- Create: `bridge/test/update-normalizer.test.mjs`
- Create: `bridge/test/message-format.test.mjs`
- Create: `bridge/test/attachment-store.test.mjs`
- Create: `bridge/test/telegram-client.test.mjs`

**Interfaces:**
- Produces: `normalizeUpdate(raw) -> NormalizedUpdate` and `conversationKey(update) -> string`.
- Produces: `splitTelegramText(text, limit=4096) -> string[]` preserving Unicode and fenced code structure.
- Produces: `AttachmentStore.saveTelegramFile(...)` and export-root validation.
- Produces: `TelegramClient` methods for polling, chat actions, text/file send, reply, edit, delete, react, file metadata, and download.

- [ ] **Step 1: Write failing normalization tests**

Cover messages, edits, channel posts, captions, every supported attachment class, replies, quotes, forum topics, callbacks, user reactions, anonymous counts, membership/service updates, and unknown updates.

- [ ] **Step 2: Implement normalization and topic-aware keys**

Private/group key is `chat_id`; forum topic key is `chat_id:message_thread_id`. Preserve actor and chat IDs as strings.

- [ ] **Step 3: Write failing formatter and path-validation tests**

Cover emoji boundaries, CRLF, long paragraphs, fenced code close/reopen, 4096 hard limits, symlink/path traversal, and configured export roots.

- [ ] **Step 4: Implement formatter and attachment storage**

- [ ] **Step 5: Write failing fake Telegram API tests**

Cover explicit `allowed_updates`, offset/timeout parameters, API errors without token leakage, 409 duplicate-poller classification, 429 `retry_after`, multipart files, reaction validation, and callback acknowledgement.

- [ ] **Step 6: Implement Telegram client and verify GREEN**

Run: `cd bridge && node --test test/update-normalizer.test.mjs test/message-format.test.mjs test/attachment-store.test.mjs test/telegram-client.test.mjs`

Commit: `feat(bridge): add telegram transport surface`

### Task 4: Codex App-Server Client, Threads, Turns, and Approvals

**Files:**
- Create: `bridge/src/app-server-client.mjs`
- Create: `bridge/src/codex-runner.mjs`
- Create: `bridge/src/approval-router.mjs`
- Create: `bridge/test/fake-app-server.mjs`
- Create: `bridge/test/app-server-client.test.mjs`
- Create: `bridge/test/codex-runner.test.mjs`
- Create: `bridge/test/approval-router.test.mjs`

**Interfaces:**
- Produces: `AppServerClient.connect({socketPath, contract})`, `request(method, params)`, `respond(id, result|error)`, and notification/request event handlers.
- Produces: `CodexRunner.runTurn(job) -> {threadId, turnId, finalText, sentActionIds, skipped}` and `interrupt(conversationKey)`.
- Produces: `ApprovalRouter.handleServerRequest(request)` and `resolveOwnerCallback(callback)`.

- [ ] **Step 1: Write failing Unix-WebSocket JSON-RPC tests**

Verify initialize handshake, request correlation, notification delivery, disconnect rejection, malformed-frame isolation, and startup contract mismatch.

- [ ] **Step 2: Implement the app-server client**

Use `new WebSocket(\`ws+unix://${socketPath}:/\`)`. App-server JSON-RPC omits the `jsonrpc` member on the wire. Do not forward delta notifications outside the process.

- [ ] **Step 3: Write failing persistent-thread and final-answer tests**

Verify `thread/resume` before each mapped turn, `thread/start` for a missing mapping, stale replacement with owner notice, text/local-image inputs, final text aggregation from completed agent items, exact-turn interrupt, timeout, `SKIP`, and no streaming Telegram output.

- [ ] **Step 4: Implement CodexRunner**

Group turns use read-only sandbox. Owner DM turns use workspace-write plus configured writable roots and `on-request`. Every turn gets Telegram identity/context as untrusted additional context and a short application output contract.

- [ ] **Step 5: Write failing approval tests**

Cover all three methods: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval`; owner-only DM callbacks; expiry; replay; conversation/turn mismatch; deny; and fail-closed unknown requests.

- [ ] **Step 6: Implement approval routing and verify GREEN**

Run: `cd bridge && node --test test/app-server-client.test.mjs test/codex-runner.test.mjs test/approval-router.test.mjs`

Commit: `feat(bridge): connect codex app-server turns and approvals`

### Task 5: Dispatcher, Engagement, Outbound Deduplication, and Poller

**Files:**
- Create: `bridge/src/engagement-policy.mjs`
- Create: `bridge/src/dispatcher.mjs`
- Create: `bridge/src/poller.mjs`
- Create: `bridge/src/index.mjs`
- Create: `bridge/test/engagement-policy.test.mjs`
- Create: `bridge/test/dispatcher.test.mjs`
- Create: `bridge/test/poller.test.mjs`

**Interfaces:**
- Produces: `EngagementPolicy.evaluate(update, context) -> {action: 'turn'|'store'|'reject', reason}`.
- Produces: `Dispatcher.processClaimedUpdate(row)` with per-key serialization and global concurrency.
- Produces: `Poller.run(signal)` with durable ingestion and bounded retries.

- [ ] **Step 1: Write failing access and engagement tests**

Verify owner DM always turns; unknown DMs reject; approved mentions, commands, replies, and reactions turn; ordinary approved group traffic stores; bot-authored traffic does not reset silence state; channel allowlists are explicit.

- [ ] **Step 2: Implement engagement policy**

- [ ] **Step 3: Write failing dispatcher tests**

Verify same-key serialization, cross-key concurrency cap, `/new`, `/stop` topic isolation, callback routing, attachment ingestion, typing renewal, automatic final send, structured `SKIP`, and suppression when an equivalent action was already sent.

- [ ] **Step 4: Implement dispatcher and poller**

On Telegram 409, stop and expose a duplicate-poller health failure. On 429, preserve state and schedule according to `retry_after` plus jitter. On an outbound crash window, record `ambiguous` and do not silently resend.

- [ ] **Step 5: Verify GREEN and commit**

Run: `cd bridge && npm test`

Commit: `feat(bridge): dispatch durable telegram work`

### Task 6: Narrow Telegram MCP and Wake-Control Sockets

**Files:**
- Create: `bridge/src/control-server.mjs`
- Create: `bridge/src/control-client.mjs`
- Create: `bridge/src/mcp-server.mjs`
- Create: `bridge/src/wake-server.mjs`
- Create: `bridge/src/wake-cli.mjs`
- Create: `bridge/test/control-server.test.mjs`
- Create: `bridge/test/mcp-server.test.mjs`
- Create: `bridge/test/wake-server.test.mjs`

**Interfaces:**
- Produces approved actions `send_text`, `send_file`, `reply`, `edit_own_message`, `delete_own_message`, `react`, and `list_chats` over the action socket.
- Produces MCP tools `telegram_send_text`, `telegram_send_file`, `telegram_reply`, `telegram_edit_own_message`, `telegram_delete_own_message`, `telegram_react`, and `telegram_list_chats`.
- Produces a separate operator wake API accepting conversation key, source, reason, context, dedupe key, earliest time, and expiry.

- [ ] **Step 1: Write failing framed-socket authorization tests**

Verify newline-delimited JSON size limits, malformed request rejection, stable aliases only, unknown chat rejection, export-root enforcement, and response correlation.

- [ ] **Step 2: Implement control server/client**

- [ ] **Step 3: Write failing MCP registration and action-ledger tests**

Assert the exact seven tools and prove `telegram_enqueue_wake` is absent.

- [ ] **Step 4: Implement MCP stdio server**

- [ ] **Step 5: Write failing wake persistence tests and implement wake endpoint**

Only `cron`, `sw`, `manual`, and configured approved sources are accepted. A wake is converted into an ordinary durable job and cannot bypass thread, approval, or outbound controls.

- [ ] **Step 6: Verify GREEN and commit**

Run: `cd bridge && npm test`

Commit: `feat(bridge): add telegram action and wake controls`

### Task 7: Deployment, Contract Tests, and Local Real-Runtime Smoke

**Files:**
- Create: `bridge/deploy/codex-tg-app.service`
- Create: `bridge/deploy/codex-tg-bridge.service`
- Create: `bridge/deploy/tmpfiles.conf`
- Create: `bridge/deploy/install.sh`
- Create: `bridge/test/contract.test.mjs`
- Create: `bridge/test/integration.test.mjs`
- Create: `bridge/scripts/smoke-app-server.mjs`
- Create: `bridge/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces repeatable host setup for `tgbridge`, `codexbot`, their shared socket group, absolute Node/Codex paths, protected runtime/state/secret paths, and two system services.

- [ ] **Step 1: Write failing contract and fake end-to-end tests**

Exercise poll, durable store, dispatch, thread start/resume, turn completion, final send, approval callback, restart recovery, outbound ambiguity, wake turn, and duplicate poller shutdown.

- [ ] **Step 2: Implement deployment files and operator documentation**

The app service starts first. The bridge service requires its socket and uses a separate credential file. Units use `ProtectSystem=strict`, `PrivateTmp=true`, explicit read/write paths, `NoNewPrivileges=true`, memory limits, and absolute executable paths verified by `install.sh`.

- [ ] **Step 3: Run the complete fake suite**

Run: `cd bridge && npm ci && npm test`

- [x] **Step 4: Run a real local app-server smoke**

Start the installed Codex binary on a private Unix socket, initialize it, start a read-only thread, run a non-destructive turn, verify a final answer, interrupt a controlled long turn, and confirm no delta was forwarded to Telegram.

- [x] **Step 5: Commit and push**

Commit: `feat(bridge): complete deployable codex telegram bridge`

Run: `git push origin main`

### Task 8: Virginia Deployment and Telegram Sandbox Acceptance

**Files:**
- Modify after verification: `bridge/fixtures/codex-app-server-<deployed-version>/contract.json`
- Modify after verification: `bridge/README.md`
- Add after verification: `docs/bridge-acceptance-2026-07-11.md`
- Add only after deployment succeeds: a harness memory update note with host alias, versions, service names, paths, and verified limitations.

- [x] **Step 1: Audit the Virginia host without changing it**

Verify Ubuntu, swap, disk, Node/Codex paths and versions, Codex login for `codexbot`, available SSH host alias, ports, existing Telegram pollers, and systemd capabilities.

- [x] **Step 2: Install services and protected paths**

- [ ] **Step 3: Configure the new BotFather token and allowlists outside Git**

Verify no webhook, one poller, Group Privacy disabled, Bot-to-Bot enabled, group access allowed, and sandbox-group admin permissions.

- [ ] **Step 4: Execute every real sandbox test from design section 15**

Record command/log evidence for DM, group mention/reply, bot-to-bot convergence, attachments, reactions, approval routing, restart recovery, exact topic stop, wake endpoint, token isolation, and final-only output.

- [ ] **Step 5: Run acceptance audit and archive evidence**

Each of the twelve design acceptance criteria must point to current runtime evidence. Any missing evidence keeps the bridge incomplete.

- [ ] **Step 6: Commit deployment evidence, update harness memory, and push**

Commit: `docs(bridge): record Virginia sandbox acceptance`
