import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VALID_STATUSES = new Set(['none', 'opened', 'ambiguous', 'blocked'])
// Keep context lookup inside the same bounded pre-acceptance budget as task
// admission so one stuck local helper cannot hold the Telegram relay lease.
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

export class TaskqContextResolver {
  #cliPath
  #dbPath
  #agentId
  #execFile
  #timeoutMs

  constructor({
    cliPath,
    dbPath,
    agentId,
    execFileImpl = execFileAsync,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  }) {
    if (!cliPath || !dbPath || !agentId) {
      throw new Error('task context resolver requires cliPath, dbPath, and agentId')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('task context resolver timeoutMs must be a positive integer')
    }
    this.#cliPath = cliPath
    this.#dbPath = dbPath
    this.#agentId = agentId
    this.#execFile = execFileImpl
    this.#timeoutMs = timeoutMs
  }

  async resolve(text, { signal } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'none', candidates: [] }
    }
    const { stdout } = await this.#execFile(this.#cliPath, [
      '--db', this.#dbPath,
      '--json', 'resolve',
      '--text', text,
      '--by', this.#agentId,
    ], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: this.#timeoutMs,
      killSignal: 'SIGKILL',
      ...(signal ? { signal } : {}),
    })
    let result
    try {
      result = JSON.parse(stdout)
    } catch {
      throw new Error('task context resolver returned invalid JSON')
    }
    if (!VALID_STATUSES.has(result?.status)) {
      throw new Error('task context resolver returned an invalid result')
    }
    return result
  }
}
