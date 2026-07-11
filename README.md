# Codex Telegram Channel

Telegram is a transport into an already-open local Codex session. The Virginia
VPS does not run Codex.

## Runtime boundaries

- VPS `tgbridge`: bot token, long polling, SQLite queue, 24-hour expiry, and
  reliable Telegram sends.
- Mac launcher: one Codex app-server shared by the interactive TUI and the
  Telegram connector.
- The launcher supervises the connector, writes `.state/channel-status.json`,
  and reconnects with bounded exponential backoff while the TUI stays open.
- SSH stdio: an outbound-only Mac connection. No listener is opened on the Mac
  or exposed publicly on the VPS.
- App-server, connector, and SSH relay processes are detached from the TUI's
  controlling terminal. Only the Codex TUI inherits terminal stdio.
- A Telegram job is claimed only while the target Codex thread is idle. Local
  TUI turns take priority.
- One queued batch can produce one compatibility reply or multiple targeted
  replies to selected messages from that batch.
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
- Jobs older than 24 hours expire silently before acceptance.

When the local connector is absent, each Telegram conversation receives this
notice once per offline epoch:

```text
Codex 会话「tg-engage」当前不在线。
```

## Tests

```bash
cd bridge
npm ci
npm test
```

The suite creates temporary Unix sockets and therefore needs local socket
permission in a restricted harness.

## VPS transport

Configure `/etc/codex-tg-bridge/bridge.env` from `.env.example`. Keep the bot
token only in `/etc/codex-tg-bridge/telegram-token`, mode `0600`, owned by
`root`.

```bash
sudo bridge/deploy/install.sh
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
    /usr/local/bin/node /opt/tg-engage/bridge/src/relay-stdio.mjs'
```

Then send a protocol `hello` frame with `acceptingJobs=false` and confirm a
`ready` response.

## Local channel

Local machine settings live in the ignored file
`bridge/.state/local-channel.json`. It contains infrastructure paths and SSH
coordinates, never the Telegram token.

Start or resume a Codex session through the channel launcher:

```bash
cd bridge
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
git clone https://github.com/zaymb/tg-engage.git
cd tg-engage
bash bridge/deploy/stage-user-release.sh
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
- Attachments, Telegram action tools, remote approvals, and `/stop` are later
  delivery phases. The current deployed path is text plus structured
  `REPLY/SKIP`.
