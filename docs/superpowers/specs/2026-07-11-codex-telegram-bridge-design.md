# Codex Telegram Bridge Design

**Date:** 2026-07-11

**Status:** Accepted for implementation

**Target host:** Tencent Lighthouse Virginia, Ubuntu 22.04, 2 vCPU / 4 GB RAM

**Reference:** `docs/refs/2026-07-10_codex-telegram-bridge-guide.md`

## 1. Objective

Run an always-on Telegram bot whose agent runtime is Codex. The bot must:

- own a new Telegram bot token and never share a poller with Laurie/Claude Code;
- receive messages in approved DMs, groups, and forum topics;
- send, reply, edit, delete, and attach files within Telegram Bot API limits;
- send reactions and receive user reaction updates;
- keep one persistent Codex thread per Telegram conversation surface;
- survive bridge, app-server, and VPS restarts without losing accepted inbound work;
- expose a narrow control interface that future cron/SW wake systems can call to initiate a Codex turn;
- show final answers only; streaming output is intentionally out of scope.

The bridge is an adapter, not the autonomous wake system. Cron and SW own when an idle agent wakes. The bridge owns transport, durable delivery, Codex thread execution, approvals, and Telegram actions.

## 2. Non-goals

- No cron, heartbeat, or SW scheduler in this implementation.
- No reuse of the existing Claude Code Telegram bot token.
- No public webhook or public app-server listener.
- No attempt to provide exactly-once Telegram sends; the Bot API has no idempotency key. The bridge minimizes duplicates and records residual ambiguity.
- No assumption that the simulation-only cosine cooldown is already production-ready.
- No streaming of reasoning, tool progress, or partial assistant output to Telegram.

## 3. Approaches Considered

### A. One Node process spawning app-server over stdio

This matches the external reference most closely and is the smallest implementation. It is rejected for production because the token-holding bridge and Codex run as the same Unix user. Removing the token from the child environment does not stop Codex from reading the bridge secret file.

### B. Two system services connected by a private Unix socket

This is the selected design.

- `codex-tg-app.service` runs as a dedicated `codexbot` user.
- `codex-tg-bridge.service` runs as a dedicated `tgbridge` user and is the only process that holds the Telegram token.
- Codex app-server listens on a filesystem-protected Unix socket.
- A second narrow control socket lets Codex Telegram tools request approved outbound actions without exposing the token.
- Shared inbox/outbox directories expose message attachments, not credentials.

This adds deployment work but creates an actual secret boundary and preserves native Codex threads, approvals, and tools.

### C. Telegram bridge calling the OpenAI Responses API directly

This is rejected because it would create a separate API agent rather than a Codex runtime using Codex threads and subscription authentication. It would require rebuilding the coding tools and approval model.

## 4. Architecture

```text
Telegram Bot API
      |
      | getUpdates / sendMessage / setMessageReaction
      v
+-----------------------------+
| tgbridge Unix user          |
| bridge service              |
| - allowlists                |
| - durable SQLite inbox      |
| - Telegram API client       |
| - message/attachment store  |
| - approval callback router  |
| - final answer formatter    |
+--------------+--------------+
               |
               | WebSocket over protected Unix socket
               v
+-----------------------------+
| codexbot Unix user          |
| codex app-server            |
| - persistent threads        |
| - turns and tools           |
| - sandbox and approvals     |
| - CODEX_HOME session state  |
+--------------+--------------+
               |
               | local MCP process -> narrow bridge control socket
               v
+-----------------------------+
| Telegram action tools       |
| - send / reply / edit       |
| - delete / send file        |
| - react                     |
| - list approved chats       |
+-----------------------------+

Future cron/SW
      |
      | enqueue wake(chat key, reason)
      v
bridge durable inbox -> Codex turn
```

Neither Unix socket is exposed outside the VPS. Filesystem ownership and a shared service group control access.

## 5. Repository Layout

Bridge code stays in this repository but remains isolated from the cooldown simulation:

```text
bridge/
  package.json
  src/
    index.mjs
    config.mjs
    telegram-client.mjs
    update-normalizer.mjs
    app-server-client.mjs
    state-store.mjs
    dispatcher.mjs
    approval-router.mjs
    attachment-store.mjs
    message-format.mjs
    control-server.mjs
    mcp-server.mjs
  test/
  deploy/
    codex-tg-app.service
    codex-tg-bridge.service
    tmpfiles.conf
  .env.example
  README.md
```

The implementation uses a currently supported Node.js LTS selected and pinned during deployment. It does not copy the reference environment's Node 18 baseline.

## 6. Identity and Access Model

### Telegram identities

- The owner Telegram user ID is the only authority for pairing, configuration changes, approvals, and system commands.
- Approved group IDs are configured explicitly.
- Other DMs are rejected before entering the durable Codex work queue.
- Group messages are treated as untrusted content even when posted by the owner; privileged actions are confirmed in the owner DM.
- Bot-to-bot mode is enabled for the new bot. Group Privacy is disabled so ordinary group messages can be ingested.

### Codex permissions

- Owner DM turns default to `workspace-write` with `on-request` approvals and configured writable roots.
- Group and non-owner turns default to `read-only`.
- Approval requests are sent to the owner DM with opaque, expiring callback tokens.
- Only callback queries from the owner ID can resolve approvals.
- Unknown approval methods, expired callbacks, and approval state mismatches fail closed.
- Current app-server methods handled explicitly:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`

The app-server contract is generated from the exact Codex CLI binary installed on Virginia and checked in as a test fixture or pinned build artifact.

## 7. Conversation and Thread Mapping

The conversation key is:

```text
private chat: chat_id
group:       chat_id
forum topic: chat_id:message_thread_id
```

Each key maps to one Codex thread ID. Turns for the same key are strictly serialized. Different keys may run concurrently up to a configured global limit.

The bridge calls `thread/resume` before a turn. Missing, corrupt, or incompatible threads are marked stale and replaced with a new thread. The bridge records this context break and tells the owner; it does not claim that old context migrated.

`/new` archives or detaches the current mapping and creates a new thread on the next turn. `/stop` targets only the active turn recorded for the issuing conversation key.

## 8. Durable State and Delivery Semantics

SQLite in WAL mode is authoritative for bridge state. Required tables:

- `telegram_updates`: raw update, normalized type, status, attempts, timestamps;
- `conversations`: conversation key, thread ID, model/effort overrides, active turn;
- `messages`: Telegram message IDs, sender/type metadata, attachment paths, Codex correlation;
- `outbound_actions`: requested action, deterministic local ID, Telegram result, ambiguity flag;
- `approvals`: opaque callback token, app-server request ID, owner, expiry, resolution;
- `wake_requests`: future cron/SW requests and manually queued proactive turns;
- `settings`: durable poll offset and schema/runtime metadata.

Polling flow:

1. Long poll with an explicit `allowed_updates` list.
2. Insert every update transactionally using `update_id` as a unique key.
3. Advance the durable poll offset only after the update is stored.
4. Workers claim pending rows with leases and retry failed processing.
5. Duplicate updates become no-ops.
6. A crash after Telegram accepted an outbound send but before the result was committed is marked `ambiguous`; retry requires a policy decision instead of silently duplicating the message.

This provides at-least-once inbound processing with idempotent local effects. Telegram outbound remains best-effort exactly-once with explicit ambiguity tracking.

## 9. Telegram Update Surface

The poller explicitly requests:

- `message` and `edited_message`;
- `channel_post` and `edited_channel_post` when approved channels are configured;
- `message_reaction` and `message_reaction_count`;
- `callback_query` for approval buttons and controls;
- membership/service updates required to maintain chat metadata.

Inbound content support:

- text and captions;
- photos and documents;
- voice, audio, video, animation, and video notes as downloaded files plus metadata;
- stickers as metadata and downloadable media when Telegram exposes a file;
- replies, quotes, sender identity, topic identity, and message edits;
- public and anonymous reaction changes.

Attachments are downloaded eagerly because the Bot API does not provide chat history. Shared attachment files are readable by `codexbot` but contain no bridge credentials.

Telegram reaction constraints are surfaced accurately:

- the bot must be a group administrator and must request reaction update types;
- user-specific reaction updates are delivered through `message_reaction`;
- anonymous counts can be delayed;
- reaction updates caused by bots are not delivered to the receiving bot;
- the bot may set one non-paid reaction per message under current Bot API limits.

## 10. Outbound Telegram Actions

The narrow local MCP/control API exposes:

- `telegram_send_text`;
- `telegram_send_file`;
- `telegram_reply`;
- `telegram_edit_own_message`;
- `telegram_delete_own_message`;
- `telegram_react`;
- `telegram_list_chats`.

Actions accept a stable conversation alias or approved conversation key. Arbitrary unknown chat IDs are rejected. File sends are restricted to configured export roots.

`telegram_enqueue_wake` is not exposed to Codex. It lives on a separate Unix control endpoint whose filesystem permissions admit only the future cron/SW service identity and an operator command. This prevents the agent from recursively scheduling its own wakeups.

For ordinary inbound turns, the bridge sends the completed final answer automatically unless the structured result says `SKIP` or the Codex turn already sent an equivalent response through a Telegram tool. The outbound action ledger prevents the common double-send path.

Long text is split without breaking Unicode, fenced code blocks, or Telegram's hard limits. Short conversational replies prefer one to three messages. Streaming is not implemented; the bridge maintains `sendChatAction(typing)` while a turn is active.

## 11. Engagement Boundary

Every approved update is stored, but not every group update must start a Codex turn.

The dispatcher calls an `EngagementPolicy` interface. Initial production policy:

- owner DM: always start a turn;
- direct bot mention, command, or reply to bot: start a turn;
- approved reaction on a known bot message: start a reaction event turn;
- ordinary group traffic: store as context and defer to the configured gate;
- bot-authored ordinary traffic: never extend a silence timer by itself.

The current linear `engage.ts` and the simulation-only cosine scheduler remain separate adapters until the runtime migration is approved. The bridge does not silently promote the simulation to production.

## 12. Wake-System Boundary

Cron and SW are deferred, but the bridge must make their later integration mechanical.

The wake control endpoint persists:

- target conversation key;
- source (`cron`, `sw`, `manual`, or another approved source);
- reason and optional context;
- dedupe key;
- earliest execution and expiry.

The bridge converts a claimed wake request into a normal Codex turn. Codex decides whether to send, react, or skip. The wake caller does not compose Telegram content and does not bypass normal thread, approval, rate-limit, or outbound-action handling.

## 13. Failure Handling

- `409 Conflict`: stop processing and report a duplicate poller; do not restart-loop.
- Telegram 429: honor `retry_after`, preserve the outbound row, and retry with jitter.
- App-server exit: fail active leases, restart with bounded backoff, resume stored threads.
- Protocol mismatch: fail startup when required methods or schemas differ from fixtures.
- Turn timeout: interrupt the exact active turn and report timeout to the originating conversation.
- Unknown update: store it and mark unsupported; never crash the poller.
- Disk full or SQLite corruption: stop accepting new updates and alert owner through a separate health path when possible.
- Secret exposure in logs: redact Bot API URLs, callback tokens, chat/user IDs in public diagnostics, and all credentials.

## 14. Deployment on Virginia

Before bridge deployment:

1. Add and verify 2–4 GB swap.
2. Create `tgbridge`, `codexbot`, and a narrow shared service group.
3. Install a supported Node.js LTS and the selected Codex CLI version using verified absolute paths.
4. Log in to Codex as `codexbot` and run a real model/tool smoke test.
5. Generate app-server schemas from that binary.
6. Create protected runtime, state, workspace, inbox, outbox, and credential paths.
7. Confirm the new Telegram bot has no webhook and no second poller.
8. Start app-server, then bridge, under systemd.

BotFather setup for the new bot:

- enable Bot-to-Bot Communication Mode;
- disable Group Privacy;
- allow groups;
- add the bot to the sandbox group as administrator so reaction updates are delivered.

## 15. Verification Strategy

### Unit tests

- config and secret redaction;
- normalization of every supported update type;
- topic-aware conversation keys;
- SQLite duplicate update and lease recovery;
- offset durability and crash points;
- per-conversation serialization and concurrency limits;
- exact-turn stop;
- stale thread replacement;
- all three app-server approval methods and fail-closed unknown methods;
- owner-only callback approval and expiry;
- outbound ambiguity and duplicate suppression;
- text/code/Unicode splitting;
- attachment path validation;
- reaction normalization and outbound reaction validation.

### Contract tests

- generated app-server schemas contain every required method and field;
- fake app-server exercises initialize, thread start/resume, turn start/completion, interrupt, tool calls, and approvals;
- fake Telegram server exercises long polling, 409, 429, files, reactions, callback queries, and API error redaction.

### Real sandbox tests

- owner DM round trip;
- group direct mention and reply;
- bot-to-bot direct message and reply without a loop;
- inbound photo/document and outbound file/photo;
- owner reaction received with actor identity;
- anonymous reaction count received;
- Codex reaction sent successfully;
- owner approval from DM resumes the correct group turn;
- another user cannot approve;
- restart during queued work resumes processing;
- restart preserves conversation thread and settings;
- `/stop` affects only the issuing topic;
- future wake-control call can initiate a turn, while no scheduler exists yet;
- process inspection proves one poller and token isolation from the Codex user.

## 16. Acceptance Criteria

The bridge is complete only when current evidence proves all of the following:

1. A new independent bot is online on Virginia under systemd.
2. Only one process polls its token and no webhook is configured.
3. Approved Telegram surfaces map to persistent Codex threads across restarts.
4. Text, supported attachments, replies, edits, and final responses work end to end.
5. Codex can independently send, reply, edit, delete, attach, and react in approved chats.
6. User reaction updates are received in a sandbox group; platform limits for bot-authored and anonymous reactions are documented in the UI behavior.
7. Current app-server approvals can be allowed or denied only by the owner in DM and resume the correct turn.
8. Durable inbox tests and restart tests prove that accepted inbound updates are not silently lost.
9. The Codex runtime cannot read the Telegram token file or token environment.
10. No streaming output is emitted.
11. The wake control interface is tested, while cron/SW implementation remains explicitly deferred.
12. Harness memory records the deployed host, service names, runtime versions, paths, and verified limitations only after real deployment succeeds.
