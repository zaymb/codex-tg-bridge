# Codex Telegram Channel

Telegram is a transport into an existing Codex session. The bridge supports
both split-host and same-host deployments.

## Runtime boundaries

- Transport service: bot token, long polling, SQLite queue, 24-hour expiry, and
  reliable Telegram sends.
- Session launcher: one Codex app-server shared by the interactive TUI and the
  Telegram connector.
- The launcher supervises the connector, writes `.state/channel-status.json`,
  and reconnects with bounded exponential backoff while the TUI stays open.
  Connected status carries a heartbeat expiry; a stale heartbeat is marked
  disconnected and the connector is restarted automatically.
- Split-host mode uses outbound-only SSH stdio. Same-host mode starts the relay
  process directly without opening a listener.
- App-server, connector, and SSH relay processes are detached from the TUI's
  controlling terminal. Only the Codex TUI inherits terminal stdio.
- A Telegram job is claimed only while the target Codex thread is idle. Local
  TUI turns take priority.
- One queued batch can produce one reply or reaction, or multiple targeted
  replies, reactions, and animated dice to selected messages from that batch.
  `reply`, `react`, and `skip` are peer model outcomes; reactions and dice do
  not require an MCP tool call.
- Consecutive messages from one conversation and one authenticated sender are
  coalesced after a bounded quiet interval. Owner-DM slash commands bypass the
  wait; batches never cross authors or conversations.
- Commentary can produce best-effort progress messages. A final result
  atomically cancels any undelivered progress so stale status text cannot arrive
  after the answer.
- Telegram attachments cross split-host relays in bounded, hashed frames.
  Supported image content is verified by magic bytes before becoming a native
  Codex image input; other files remain explicit local-path references.
- A pure Telegram batch uses a structured envelope whose `responses` field is
  always present; ordinary replies and skips use an empty array. The shared
  session does not force this with `response_format`, because a local TUI steer
  can join the active turn and must still receive a normal terminal answer.
- Every injected Telegram message is prefixed with `[TG]` and its automatic
  `conversation_key`; an unmarked user turn came from the terminal or another
  local Codex client.
- Telegram windows are isolated by `conversation_key`: a DM or group uses its
  `chatId`, while a forum topic uses `chatId:threadId`. Batches never cross that
  boundary, and outbound routing is resolved from the durable inbound context.
- Replies are bound to the channel that started the turn. If a local TUI steer
  joins a Telegram-owned turn, the connector fails closed and does not send the
  mixed final answer to Telegram.
- Optional forum-topic display names come from the local
  `TELEGRAM_TOPIC_NAMES` JSON mapping; private chat IDs and names never need to
  be compiled into the bridge.
- Jobs older than 24 hours expire silently before acceptance.
- Human reactions to known bot messages are requested explicitly through
  `allowed_updates`, restored to the message's original forum topic, and
  delivered as normal `[TG]` events. Telegram does not publish bot-authored
  reaction updates.
- App-server approval requests for the shared thread are relayed only to the
  configured owner's private chat. Inline Approve/Deny callbacks are one-use,
  expire after ten minutes, and return to the same app-server request without
  becoming model input. This also covers terminal-originated turns because the
  connector subscribes to the same app-server thread as the TUI.

When the local connector is absent, each Telegram conversation receives this
notice once per offline epoch:

```text
Codex 会话「tg-engage」当前不在线。
```

## Tests

```bash
npm ci
npm test
```

The suite creates temporary Unix sockets and therefore needs local socket
permission in a restricted harness.

## VPS transport

Configure `/etc/codex-tg-bridge/bridge.env` from `.env.example`. Keep the bot
token only in `/etc/codex-tg-bridge/telegram-token`, mode `0600`, owned by
`root`. `BRIDGE_ATTACHMENT_ROOT` must match the local channel's
`relayAttachmentRoot`; the supplied deployment uses `/srv/codex-inbox`.

```bash
sudo deploy/install.sh
sudo systemctl enable --now codex-tg-bridge.service
```

The service starts `transport-index.mjs`; it has no app-server socket, Codex
login, workspace, or model dependency.

Relay preflight, without claiming work:

```bash
ssh -T relay-host \
  'sudo -n -u tgbridge env \
    BRIDGE_DB_PATH=/var/lib/codex-tg-bridge/bridge.sqlite3 \
    BRIDGE_SESSION_LABEL=tg-engage \
    /usr/local/bin/node /opt/codex-tg-bridge/src/relay-stdio.mjs'
```

Then send a protocol `hello` frame with `acceptingJobs=false` and confirm a
`ready` response.

## Local channel

Local machine settings live in the ignored file
`.state/local-channel.json`. It contains infrastructure paths and SSH
coordinates, never the Telegram token.

Start or resume a Codex session through the channel launcher:

```bash
npm run channel -- <codex-session-id>
```

The launcher starts a temporary local app-server, attaches the Telegram
connector, and opens the normal Codex TUI on the same thread. Exiting the TUI
closes the connector and app-server. It installs no launchd service.

The checked contract fixture targets local `codex-cli 0.144.1`. Regenerate and
review it whenever Codex CLI changes; startup fails closed on a version mismatch.

### Same-host VPS staging

When Telegram transport and Codex run under the same Unix user, set
`BRIDGE_RELAY_MODE=local`. The connector then starts `relay-stdio.mjs` directly
with the configured absolute Node, script, and SQLite paths; it does not invoke
SSH. The existing `ssh` mode remains the default for split-host deployments.

Before changing an existing user service, stage an isolated Node 24 runtime and
a separate tested release:

```bash
git clone https://github.com/zaymb/codex-tg-bridge.git
cd codex-tg-bridge
bash deploy/stage-user-release.sh
```

The staging script downloads a pinned archive from `nodejs.org`, verifies it
against the official `SHASUMS256.txt`, and installs it below
`${XDG_DATA_HOME:-$HOME/.local/share}/codex-tg-bridge/runtime/`. It copies the
bridge into a commit-addressed release directory, runs syntax checks and the
full test suite with the isolated binary, and prints an installation report.
It never edits PATH, symlinks, `.env`, credentials, durable state, or systemd.
Service switching is a separate, explicitly approved phase.

## Telegram setup

For owner DM, no group configuration is needed. Before group acceptance:

1. Enable groups and Bot-to-Bot Communication Mode in BotFather.
2. Disable Group Privacy.
3. Add the bot to the sandbox group with the rights needed for reaction events.
4. Confirm `getWebhookInfo.url` is empty.
5. Run only one `getUpdates` poller for the token.

## Failure semantics

- Raw Telegram updates and relay jobs are durable and deduplicated.
- A job becomes non-replayable after app-server returns its exact turn ID.
- A local-turn race returns the unaccepted job to the queue.
- Telegram rate limits defer the outbound row. Ambiguous sends are never
  automatically repeated.
- Final relay result and outbound actions commit in one SQLite transaction.
- Successful bot reactions are captured in a durable, idempotent event outbox
  for side-channel consumers and never extend engagement cooldown.
- Approval callbacks are authorized only in the configured owner's DM and fail
  closed when expired, cancelled, or detached from the active Codex session.
- The current structured model path is `SEND/REACT/SKIP`; Telegram action tools,
  attachments, `/stop`, and durable remote approvals use the same outbox and
  routing boundaries.

## Trust boundary

- Every Telegram turn is tagged as an `EXTERNAL_FEED` with an authenticated
  trust tier. The configured owner's private chat and owner-authored turns in
  configured repair groups are instruction sources; other group messages remain
  conversation data.
- `TELEGRAM_PRIVATE_CHAT_IDS` defines private audiences that may receive
  owner-private architecture discussion. These groups remain non-authoritative:
  they cannot start work, mutate state, approve actions, or control sessions.
- `TELEGRAM_REPAIR_CHAT_IDS` defines repair surfaces. An authenticated owner
  message in one of these groups may start work and use the configured Codex
  permissions. Messages from peer bots or other members remain non-authoritative,
  even in the same repair group. Relay batches never cross Telegram authors, so
  coalescing cannot downgrade or accidentally promote a neighboring message.
- Group slash commands are stored as context and never execute bridge control
  actions. `/new`, `/stop`, approvals, and mutations require the terminal or
  owner DM.
- Untrusted turns run with `readOnly`, network disabled, `approvalPolicy=never`,
  and automatic denial of any approval request that still reaches the local
  connector.
- Public Telegram output passes a deterministic disclosure guard. Concrete
  local paths, credentials, environment/config identifiers, private
  infrastructure details, code blocks, oversized responses, and file exports
  are blocked outside the owner DM.
- Private-audience groups use a narrower guard: architecture discussion is
  allowed, while credentials, secrets, and exact private paths remain blocked.
