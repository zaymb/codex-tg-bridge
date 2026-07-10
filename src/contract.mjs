import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REQUIRED_PROTOCOL_SCHEMAS = Object.freeze({
  initialize: 'v1/InitializeParams.json',
  'thread/start': 'v2/ThreadStartParams.json',
  'thread/resume': 'v2/ThreadResumeParams.json',
  'turn/start': 'v2/TurnStartParams.json',
  'turn/interrupt': 'v2/TurnInterruptParams.json',
  'model/list': 'v2/ModelListParams.json',
  'thread/started': 'v2/ThreadStartedNotification.json',
  'turn/started': 'v2/TurnStartedNotification.json',
  'turn/completed': 'v2/TurnCompletedNotification.json',
  'item/started': 'v2/ItemStartedNotification.json',
  'item/completed': 'v2/ItemCompletedNotification.json',
  error: 'v2/ErrorNotification.json',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalParams.json',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalParams.json',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalParams.json',
})

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function validateContract(contract) {
  if (!contract || contract.protocol !== 'codex-app-server') {
    throw new Error('invalid Codex app-server contract')
  }
  if (typeof contract.codexVersion !== 'string' || contract.codexVersion.length === 0) {
    throw new Error('contract is missing codexVersion')
  }
  for (const method of Object.keys(REQUIRED_PROTOCOL_SCHEMAS)) {
    const entry = contract.schemas?.[method]
    if (!entry) throw new Error(`contract is missing ${method}`)
    if (entry.path !== REQUIRED_PROTOCOL_SCHEMAS[method]) {
      throw new Error(`invalid schema path for ${method}`)
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid schema hash for ${method}`)
    }
  }
  return contract
}

export async function captureContract({ schemaDir, codexVersion }) {
  if (!schemaDir) throw new Error('schemaDir is required')
  if (!codexVersion) throw new Error('codexVersion is required')

  const schemas = {}
  for (const [method, relativePath] of Object.entries(REQUIRED_PROTOCOL_SCHEMAS)) {
    let contents
    try {
      contents = await readFile(join(schemaDir, relativePath))
    } catch {
      throw new Error(`missing required Codex schema for ${method}: ${relativePath}`)
    }
    schemas[method] = { path: relativePath, sha256: sha256(contents) }
  }

  return validateContract({
    protocol: 'codex-app-server',
    codexVersion,
    capturedAt: new Date().toISOString(),
    schemas,
  })
}
