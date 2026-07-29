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
  disconnected and the connector is restarted automatically. An intentional
  disengage is different: status becomes `disengaged`, automatic reconnect is
  disabled, and the TUI/app-server continue as a standalone local session.
- Split-host mode uses outbound-only SSH stdio. Same-host mode starts the relay
  process directly without opening a listener.
- App-server, connector, and SSH relay processes are detached from the TUI's
  controlling terminal. Only the Codex TUI inherits terminal stdio.
- A Telegram job is claimed only while the target Codex thread is idle. Local
  TUI turns take priority.
- An optional shared task admission gate can grant one agent execution
  ownership for an otherwise authorized Telegram message. Other agents still
  receive the message, but their copy is downgraded to read-only permissions.
- One queued batch can produce a standalone send, an intentional reply or
  reaction, or multiple targeted actions. A targeted standalone send may name
  any conversation in the durable approved-chat registry, even when that
  conversation is absent from the current batch. Targeted replies, reactions,
  and animated dice remain limited to exact messages in the current batch.
  The model selects `send`, `reply`, `react`, `skip`, or `targeted`; the
  connector mechanically generates the transport envelope.
- Pending conversations share one bounded quiet interval and are delivered in
  one source-grouped batch. Each conversation contributes only its first
  contiguous authenticated-sender partition. Owner-DM slash commands bypass
  the wait and remain isolated from ordinary messages.
- Commentary can produce best-effort progress messages. `send` remains
  standalone; only an explicit `reply` decision binds progress to a message.
  A final result atomically cancels any undelivered progress so stale status
  text cannot arrive after the answer.
- Telegram attachments cross split-host relays in bounded, hashed frames.
  Supported image content is verified by magic bytes before becoming a native
  Codex image input; other files remain explicit local-path references.
- A pure Telegram batch uses a fixed `decision`, `text`, and `targets` schema.
  Models never hand-write transport `action`, `responses`, or `reason` fields.
  Missing or malformed final decisions fail the accepted job visibly instead
  of being recorded as an intentional skip.
- Rolling deployment temporarily accepts the previous well-formed JSON action
  envelope and logs each use as `local_connector_legacy_output`. Remove that
  compatibility parser after seven consecutive production days with zero such
  events; malformed JSON, field aliases, prose markers, and trailing text are
  not compatibility inputs.
- Every injected Telegram message is prefixed with `[TG]` and its automatic
  `conversation_key`; an unmarked user turn came from the terminal or another
  local Codex client.
- Telegram destinations are isolated by `conversation_key`: a DM or group uses
  its `chatId`, while a forum topic uses `chatId:threadId`. A batch may span
  several conversations. Selective replies require both `conversationKey` and
  `messageId`; an unqualified ambiguous target fails closed. A root `reply`
  goes only to the globally latest message. A root `send` uses the latest
  conversation without a reply target. A targeted `send` requires
  `messageId=null` and a registered approved conversation.
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

### Transport controls

`/away Nm` accepts integer durations from 1 to 60 minutes. Telegram intake is
stored durably but no Codex turn starts until the timer expires or the owner
mentions the bot. The timer starts only after Telegram confirms the reply
`Will be back in Nm.`

`/disengage` is a hard, manual boundary. After Telegram confirms
`Until next time.`, the transport stops polling, drains accepted relay work and
outbound actions, persists a ready marker, and exits with status 78. The relay
then tells the local connector to close; that connector waits for its detached
SSH/process relay to exit, escalating from TERM to KILL after the configured
grace period. Its supervisor records `disengaged` and does not reconnect. The
shared Codex TUI and app-server stay open locally.

An authenticated admin can send exact `/stop` (including a matching bot
mention), exact `stop` (case-insensitive), or exact `停` from any chat. The
transport records the request before replying and sends it over the control
channel even while an ordinary relay job is active. The local connector then
calls `turn/interrupt` for the attached thread. With an interrupt fanout
configured, the same control also latches the shared stopped state and signals
the verified peer runtime. Exact `/continue`, `continue`, or `继续` clears that
latch over the same out-of-band path. Longer text such as `停一下` or
`continue working` remains ordinary conversation input.

`/stop elio` interrupts only the local Codex turn and replies `Elio stopped.`.
`/stop laurie` invokes only the verified peer fanout and emits no receipt from
this bridge; Laurie's plugin replies `Laurie stopped.` itself. Bare `/stop`
keeps the all-agent interrupt behavior, but this bridge acknowledges only
Elio; Laurie's plugin emits its own receipt. Target names are exact; unknown
names are not executed.

Re-engage is deliberately two explicit operations, remote first and local
second:

```bash
# On the transport host, with the transport environment loaded:
node scripts/engage.mjs
sudo systemctl start codex-tg-bridge

# On the local host, for the still-open channel launcher:
npm run engage-local
```

The local command refuses unless the channel status is exactly `disengaged`;
it signals only the recorded launcher PID. Network recovery alone never
reconnects a disengaged channel.

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

To coordinate execution with another agent, both connectors must use the same
taskq database and distinct agent IDs:

```json
{
  "taskAdmission": {
    "cliPath": "/absolute/path/to/taskq.py",
    "dbPath": "/absolute/path/to/tasks.sqlite3",
    "agentId": "elio"
  }
}
```

The launcher exports all three admission settings together. Partial
configuration fails closed at startup. The admission key is the immutable
`conversationKey + messageId`; command failure or malformed output removes
execution authority from that message instead of falling back to prompt-level
coordination.

An optional local interrupt fanout gives one authenticated stop control the
same effect across cooperating runtimes without exposing another user
interface:

```json
{
  "interruptFanout": {
    "command": "/absolute/path/to/verified-interrupt-helper",
    "stopFlagPath": "/absolute/path/to/shared-stop.flag"
  }
}
```

Both values are required together. The connector runs the command directly
without a shell, passes `stop|continue`, request ID, conversation key, and the
validated target as arguments, and uses the existing relay shutdown grace
budget as its timeout.
While the shared flag exists, heartbeats advertise that ordinary jobs are not
accepted; control frames continue to pass so `continue` cannot deadlock behind
the latch.

Start or resume a Codex session through the channel launcher:

```bash
npm run channel -- <codex-session-id>
```

The launcher starts a temporary local app-server, attaches the Telegram
connector, and opens the normal Codex TUI on the same thread. Exiting the TUI
closes the connector and the app-server's detached process group. The optional
`appServerShutdownGraceMs` setting controls the bounded TERM grace period before
the exact group is killed; the default is 2000 ms. `relayCloseGraceMs` applies
the same 2000 ms default to the detached SSH/local relay process. It installs
no launchd service.

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
- Telegram API failures and relay-side result rejection both return a typed
  failed-delivery receipt to the local connector. The launcher records it in
  channel status and prints one terminal alert; successful delivery stays
  quiet apart from durable status.
- Final relay result and outbound actions commit in one SQLite transaction.
- Successful bot reactions are captured in a durable, idempotent event outbox
  for side-channel consumers and never extend engagement cooldown.
- Approval callbacks are authorized only in the configured owner's DM and fail
  closed when expired, cancelled, or detached from the active Codex session.
- The current structured model path is
  `send/reply/react/skip/targeted(send|reply|react|dice)`; Telegram action tools,
  attachments, `/stop`, and durable remote approvals use the same outbox and
  routing boundaries.

## Trust boundary

- Every Telegram message is tagged as an `EXTERNAL_FEED`. Source trust and
  sender identity are computed independently by the connector: owner DM and
  configured repair groups are `trusted` sources, while only the configured
  human owner is `admin`. A message can authorize execution only when both are
  true.
- `TELEGRAM_PRIVATE_CHAT_IDS` defines private audiences that may receive
  owner-private architecture discussion. These groups remain non-authoritative:
  they cannot start work, mutate state, approve actions, or control sessions.
- `TELEGRAM_REPAIR_CHAT_IDS` defines repair surfaces. An authenticated owner
  message in one of these groups may start work and use the configured Codex
  permissions. Messages from peer bots or other members remain non-authoritative,
  even in the same repair group.
- While Codex is busy, Telegram jobs remain durable in the relay queue. Once the
  session is available, every pending message in each ready conversation joins
  the same bounded batch; sender changes do not split it. Model input is grouped
  by conversation, preserves natural order within each source, and retains every
  `message_id` for selective replies.
- For mixed-source batches, the connector emits an exact
  `telegram_authorization.authorizedMessages` manifest. Only listed
  `conversationKey + messageId` pairs may authorize work. Other messages remain
  conversation data, and authority never transfers between messages or sources.
- The connector also emits typed `mayReply` and `mayExecute` capabilities per
  message. They are independent: an untrusted message may allow a normal social
  reply while still denying every tool call and state change.
- Ordinary group slash commands are stored as context and never execute bridge
  control actions. `/new` and approval callback resolution require the terminal
  or owner DM. The transport-only `/away`, `/disengage`, exact stop controls,
  and exact continue controls are the narrow exception: they bypass the model
  and require the authenticated admin sender, independent of conversation
  trust. Ordinary tool
  work requested by an authorized repair message still follows the manifest
  rule above.
- Batches with no authorized message run with `readOnly`, network disabled,
  `approvalPolicy=never`, and automatic denial of any approval request that
  still reaches the local connector.
- Public Telegram output passes a deterministic disclosure guard. Concrete
  local paths, credentials, environment/config identifiers, private
  infrastructure details, code blocks, oversized responses, and file exports
  are blocked outside the owner DM.
- Private-audience groups use a narrower guard: architecture discussion is
  allowed, while credentials, secrets, and exact private paths remain blocked.
