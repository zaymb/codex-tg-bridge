#!/usr/bin/env node
// Manual re-engage after /disengage. Clears the persisted transport control
// state so the next `systemctl start codex-tg-bridge` boots a live transport
// instead of a tombstone. This is deliberately the only way back — there is
// no automatic recovery path.
//
// Usage: node scripts/engage.mjs   (same env/config as the transport)

import { loadTransportConfig } from '../src/config.mjs'
import { StateStore } from '../src/state-store.mjs'

const config = loadTransportConfig(process.env)
const store = StateStore.open(config.dbPath)
try {
  const before = store.getSetting('transport_control_state')
  store.setSetting('transport_control_state', JSON.stringify({ away: null, disengage: null }))
  console.log(JSON.stringify({
    level: 'info',
    event: 'transport_engaged',
    dbPath: config.dbPath,
    cleared: before ? JSON.parse(before) : null,
  }))
  console.log('Transport control state cleared. Start the unit manually: systemctl start codex-tg-bridge')
} finally {
  store.close()
}
