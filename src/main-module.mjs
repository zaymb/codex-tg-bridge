import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath)
  } catch {
    return false
  }
}
