# Operating Lessons

This document records the design constraints learned while building and
operating the bridge. These are invariants, not optional conventions.

## Bind Source To Destination

Telegram supplies stable routing data on every update. Normalize and persist
it before model execution:

- `chatId` identifies a DM, group, or channel.
- `conversationKey = chatId` for a normal chat.
- `conversationKey = chatId:threadId` for a forum topic.
- `messageId` is meaningful only inside its original chat.

Batches may contain more than one `conversationKey`. Every model-selected
outbound action must name its `conversationKey`; replies, reactions, and dice
must also name a `messageId` from the accepted batch. Standalone sends may name
only a conversation in the durable approved-chat registry. The relay resolves
`chatId` and `threadId` from durable context and rejects missing or disagreeing
routing data. The unquoted continuation of the latest message—or of the batch
as a whole—is a targeted standalone send with `messageId=null`. Reply is only
for selecting an older message from a multi-message batch. If the model marks
the latest message as a reply, the outbound hook canonicalizes it to an
unquoted send and reports that correction back to the local connector. The
connector teaches the rule on the next trusted owner turn without resending the
already-delivered text. Invalid cross-chat or unknown-message targets still
fail closed.

## Treat Shared Turns As Mixed-Source

The local TUI and Telegram connector can share one Codex thread. A terminal
message may steer a turn that Telegram started.

Every injected Telegram input therefore carries an automatic `[TG]` marker and
`conversation_key`. Unmarked input is local. If a local steer joins a
Telegram-owned turn, the final answer is mixed-source and must not be sent to
Telegram.

Do not force a strict Telegram response schema on a shared turn. Response
schemas are fixed when the turn starts, so a later terminal steer would still
be forced to display the Telegram JSON envelope. Use a conditional output
contract for the shared connector and fail closed at the outbound boundary.

## Persist Before Side Effects

- Store Telegram updates before advancing the polling offset.
- Deduplicate updates, relay jobs, and outbound actions.
- Claim work only while the selected Codex thread is idle.
- Once app-server returns an exact turn ID, the job is non-replayable.
- Commit final relay results and outbound actions in one transaction.
- Do not automatically repeat ambiguous Telegram sends.
- Expire unaccepted relay work after its business deadline.

This avoids both silent loss and duplicate model or Telegram side effects.

## Keep The TUI TTY Isolated

Only the interactive TUI may inherit terminal stdio. App-server, connector,
relay, and SSH processes use ignored or piped stdio and detached process
groups. Split-host SSH uses `-T` and `RequestTTY=no`.

Otherwise an SSH child can change the host terminal's `termios` during exit,
reenable echo, and expose raw terminal keyboard protocol bytes in the TUI.

## Liveness Requires Fresh Heartbeats

A process existing is not proof that the channel works, and a status file that
once said `connected` is not proof either.

Connected status includes both the last heartbeat and its expiry. If the relay
heartbeat becomes stale, the supervisor writes `disconnected`, terminates the
connector, and reconnects with bounded backoff. Operators and tooling must
treat an expired connected status as offline.

## Support Both Topologies Explicitly

Split-host mode runs transport remotely and reaches it through SSH stdio.
Same-host mode starts `relay-stdio.mjs` directly and requires no SSH identity.
Do not emulate same-host operation by SSHing to localhost.

Resolve and record absolute runtime binaries. Do not trust an interactive
`PATH`, which may contain wrappers or differ from systemd. For upgrades, stage
a versioned runtime from an official archive, verify SHA-256, install a separate
commit-addressed release, and run syntax checks plus the full test suite before
service changes. Never overwrite credentials, environment files, or durable
state during staging.

## Migrate Self-Hosting Infrastructure Safely

The bridge can be responsible for carrying the conversation that asks it to
migrate itself. That makes repository and runtime moves control-plane changes.

Use this order:

1. Stage the new runtime and release without changing the active service.
2. Run tests and a non-claiming relay preflight from the new release.
3. Keep the old runtime and code path intact.
4. Stop the old connector, start the new connector, and wait for a fresh relay
   heartbeat.
5. If the heartbeat does not arrive, restart the old connector from the retained
   path.
6. Delete old files only after the new channel remains healthy.

Never delete or move the code path of the currently running supervisor before
handover. Also keep the bridge in its own repository; coupling transport
infrastructure to an unrelated product repository makes deployment boundaries
and ownership ambiguous.

## Keep The Active Runtime Checkout Clean

The local connector and remote relay reject different runtime fingerprints.
Uncommitted edits under `src/` in the active checkout therefore become a latent
outage: the current connection can survive, but every later reconnect will fail.

- Do not leave runtime WIP overnight in the checkout used by a live bridge.
- Develop runtime changes in a separate worktree and run the full suite there.
- Stage the tested release before switching either side of a split-host pair.
- Every connector rejection must persist its exit details and stderr reason in
  `.state/connector-failures.jsonl`; reconnect status must retain the latest
  failure until a fresh heartbeat proves recovery.

## Release Checklist

- Repository contains no credentials, private paths, or mutable state.
- Source and destination routing invariants have tests.
- Terminal/TG mixed-turn behavior has tests.
- Connector stdio and TTY ownership have tests.
- Heartbeat expiry and reconnect have tests.
- Same-host and split-host process construction have tests.
- Staging uses an isolated runtime and leaves the active service untouched.
- Linux CI passes before a release tag is handed to another operator.
