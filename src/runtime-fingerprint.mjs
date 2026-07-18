import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

function sourceFiles(root) {
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path)
    }
  }
  visit(root)
  return files.sort()
}

export function fingerprintRuntimeSources(root) {
  const hash = createHash('sha256')
  for (const path of sourceFiles(root)) {
    hash.update(relative(root, path))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const sourceRoot = dirname(fileURLToPath(import.meta.url))

export const RELAY_RUNTIME_FINGERPRINT = fingerprintRuntimeSources(sourceRoot)
