import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const CONTROL_ACTIONS = new Set(['stop', 'continue'])
const CONTROL_TARGETS = new Set(['all', 'laurie'])

export class CommandInterruptFanout {
  #command
  #stopFlagPath
  #timeoutMs
  #execFile

  constructor({ command, stopFlagPath, timeoutMs, execFileImpl = execFile }) {
    this.#command = command
    this.#stopFlagPath = stopFlagPath
    this.#timeoutMs = timeoutMs
    this.#execFile = execFileImpl
  }

  isStopped() {
    if (!existsSync(this.#stopFlagPath)) return false
    try {
      return readFileSync(this.#stopFlagPath, 'utf8').trim() !== 'target=laurie'
    } catch {
      return true
    }
  }

  apply({ action, requestId, conversationKey, target = 'all' }) {
    if (!CONTROL_ACTIONS.has(action)) throw new Error(`unsupported interrupt fanout action: ${action}`)
    if (!CONTROL_TARGETS.has(target)) throw new Error(`unsupported interrupt fanout target: ${target}`)
    return new Promise((resolve, reject) => {
      this.#execFile(
        this.#command,
        [action, requestId, conversationKey, target],
        {
          timeout: this.#timeoutMs,
          windowsHide: true,
        },
        error => {
          if (error) {
            reject(new Error(`interrupt fanout failed: ${error.message}`, { cause: error }))
            return
          }
          resolve()
        },
      )
    })
  }
}
