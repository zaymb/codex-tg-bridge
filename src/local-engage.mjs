import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function engageLocalConnector({
  configPath,
  bridgeRoot,
  signalImpl = process.kill,
} = {}) {
  if (!configPath || !bridgeRoot) throw new Error('configPath and bridgeRoot are required')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const statusPath = resolve(bridgeRoot, config.statusPath ?? '.state/channel-status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  if (status.status !== 'disengaged') throw new Error('channel is not disengaged')
  if (!Number.isSafeInteger(status.launcherPid) || status.launcherPid <= 1) {
    throw new Error('disengaged channel status has no valid launcher PID')
  }
  signalImpl(status.launcherPid, 'SIGUSR1')
  return {
    launcherPid: status.launcherPid,
    codexSessionId: status.codexSessionId ?? null,
  }
}
