import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
// taskq is a local SQLite CLI. Ten seconds is two normal relay heartbeat
// periods and one twelfth of the 120-second pre-acceptance job lease.
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

export class TaskqMessageAdmission {
  #cliPath
  #dbPath
  #agentId
  #execFile
  #retentionSeconds
  #timeoutMs

  constructor({
    cliPath,
    dbPath,
    agentId,
    execFileImpl = execFileAsync,
    retentionSeconds = 86_400,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  }) {
    if (!cliPath || !dbPath || !agentId) {
      throw new Error('task admission requires cliPath, dbPath, and agentId')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('task admission timeoutMs must be a positive integer')
    }
    this.#cliPath = cliPath
    this.#dbPath = dbPath
    this.#agentId = agentId
    this.#execFile = execFileImpl
    this.#retentionSeconds = retentionSeconds
    this.#timeoutMs = timeoutMs
  }

  async claim({ conversationKey, messageId }, { signal } = {}) {
    if (!conversationKey || !messageId) return false
    const source = `telegram:${conversationKey}:${messageId}`
    const { stdout } = await this.#execFile(this.#cliPath, [
      '--db', this.#dbPath,
      '--json', 'admit',
      '--source', source,
      '--by', this.#agentId,
      '--retention-seconds', String(this.#retentionSeconds),
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: this.#timeoutMs,
      killSignal: 'SIGKILL',
      ...(signal ? { signal } : {}),
    })
    let result
    try {
      result = JSON.parse(stdout)
    } catch {
      throw new Error('task admission returned invalid JSON')
    }
    if (typeof result?.acquired !== 'boolean' || typeof result?.owner !== 'string') {
      throw new Error('task admission returned an invalid result')
    }
    return result.acquired
  }
}
