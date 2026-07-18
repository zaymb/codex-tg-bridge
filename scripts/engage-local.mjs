#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { engageLocalConnector } from '../src/local-engage.mjs'

const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = process.env.BRIDGE_LOCAL_CONFIG
  ? resolve(process.env.BRIDGE_LOCAL_CONFIG)
  : join(bridgeRoot, '.state', 'local-channel.json')

const result = await engageLocalConnector({ configPath, bridgeRoot })
console.log(JSON.stringify({
  level: 'info',
  event: 'local_connector_engage_requested',
  ...result,
}))
