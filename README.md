# Codex Telegram Bridge

This directory contains the isolated Telegram transport for the Codex runtime. It is intentionally separate from `engage.ts` and the cooldown simulator.

## Runtime boundaries

- `tgbridge` owns the Telegram token, long polling, SQLite state, attachments, approvals, and outbound actions.
- `codexbot` owns Codex authentication, threads, turns, tools, and the workspace.
- Codex reaches Telegram through `/run/codex-tg/action/action.sock`; it cannot read the token credential.
- Cron/SW/operator wake requests use `/run/codex-tg/wake/wake.sock`. This endpoint is not an MCP tool and is not accessible to `codexbot` in the deployment groups.
- Telegram receives completed final answers only. Agent-message deltas are opted out and never forwarded.
- The app-server socket is held at `codex-tg:0660`; startup ordering does not release the bridge until that mode is applied.

## Local verification

```bash
cd bridge
npm ci
npm test
node scripts/smoke-app-server.mjs
```

The complete test suite opens local Unix sockets. In a restricted harness it must be granted local socket permissions. The real smoke requires the installed `codex --version` to match the checked fixture.

## Configuration

Copy values from `.env.example` into `/etc/codex-tg-bridge/bridge.env`. Keep the real token only in `/etc/codex-tg-bridge/telegram-token`, mode `0600`, owned by `root`.

Required Telegram setup for the new independent bot:

1. Enable groups and Bot-to-Bot Communication Mode in BotFather.
2. Disable Group Privacy.
3. Add the bot to the sandbox group as administrator for reaction updates.
4. Confirm `getWebhookInfo.url` is empty.
5. Do not run another `getUpdates` process for this token.

`TELEGRAM_CHAT_ALIASES` accepts base chats and forum topics:

```dotenv
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
TELEGRAM_CHAT_ALIASES={"sandbox":"-1001234567890","sandbox-topic":"-1001234567890:77"}
```

The configured owner, chats, channels, topics, and aliases replace the durable approved-chat ledger on every startup. Removing a target from configuration revokes MCP and wake access after restart. `owner` is a reserved alias.

## Virginia installation

The installer is deliberately non-enabling. It verifies Node 24, the absolute Codex binary, at least 2 GiB swap, creates service identities and socket groups, installs the code, regenerates the deployed app-server contract, and installs hardened units.

```bash
sudo bridge/deploy/install.sh
sudo install -o root -g root -m 0600 /path/to/token /etc/codex-tg-bridge/telegram-token
sudo install -o root -g tgbridge -m 0640 /path/to/bridge.env /etc/codex-tg-bridge/bridge.env
sudo -u codexbot env HOME=/var/lib/codexbot CODEX_HOME=/var/lib/codexbot/.codex /usr/local/bin/codex login
sudo systemctl enable --now codex-tg-app.service codex-tg-bridge.service
```

Preflight before enabling:

```bash
sudo -u codexbot env HOME=/var/lib/codexbot CODEX_HOME=/var/lib/codexbot/.codex \
  /usr/local/bin/codex exec --sandbox read-only "Reply with CODEX_LOGIN_OK"
sudo systemd-analyze verify /etc/systemd/system/codex-tg-app.service
sudo systemd-analyze verify /etc/systemd/system/codex-tg-bridge.service
```

The deployment must use the paths verified on the host. If Node or Codex is not at the pinned unit path, update the units and deployment tests before installation; do not add PATH-dependent wrappers.

## Operator wake

The wake CLI persists a request; it does not compose Telegram content or bypass Codex policy:

```bash
sudo -u tgbridge env BRIDGE_WAKE_SOCKET=/run/codex-tg/wake/wake.sock \
  /usr/bin/node /opt/tg-engage/bridge/src/wake-cli.mjs \
  --target sandbox-topic \
  --source manual \
  --reason "Review the latest group context and decide whether to respond" \
  --dedupe-key "manual:review:001" \
  --expires-in-sec 600
```

## Failure semantics

- Inbound Telegram delivery is at least once; duplicate `update_id` values are local no-ops.
- Poll offset advances only after the raw update is stored.
- A `409` duplicate poller exits with code `78`; systemd does not restart-loop it.
- A `429` defers the outbound ledger row using `retry_after`; Codex is not rerun.
- A transport failure after a Telegram send may be `ambiguous`; it is never automatically resent.
- Same-conversation turns are serialized. Different conversations use the configured global concurrency limit.
- `/new` detaches the current mapping. `/stop` preempts and interrupts only the active turn for that conversation key. Both commands are owner-only, including inside groups.
- A turn source is persisted before `turn/start`. Once app-server acceptance is possible, an uncertain failure is recorded as failed and is not automatically replayed; this avoids duplicating workspace or Telegram-tool side effects.
- Interrupted `sending` rows become `ambiguous` on restart and are never blindly resent. Orphaned approvals expire on startup.
- Startup requires the live app-server version in `initializeResult.userAgent` to exactly match the generated contract's Codex CLI version. The current protocol does not expose live schema hashes, so deployment regenerates the fixture from the installed binary.
- Unknown app-server approval methods fail closed.

## Current limit

Cron and SW schedulers are not implemented here. Only their durable wake interface exists. Real Telegram and Virginia acceptance evidence must be recorded before calling the deployment complete.
