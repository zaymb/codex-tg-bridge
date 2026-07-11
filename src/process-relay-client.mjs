import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class ProcessRelayClient extends EventEmitter {
  #command
  #args
  #spawn
  #frameMaxBytes
  #connectTimeoutMs
  #env
  #child = null
  #lines = null
  #closed = false

  constructor({
    command,
    args = [],
    spawnImpl = spawn,
    frameMaxBytes = 262_144,
    connectTimeoutMs = 15_000,
    env = process.env,
  }) {
    super()
    this.#command = command
    this.#args = args
    this.#spawn = spawnImpl
    this.#frameMaxBytes = frameMaxBytes
    this.#connectTimeoutMs = connectTimeoutMs
    this.#env = env
  }

  connect(hello) {
    if (this.#child) throw new Error('relay process is already started')
    this.#child = this.#spawn(this.#command, this.#args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...this.#env, TERM: 'dumb' },
    })
    this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => fail(new Error('relay connection timed out')), this.#connectTimeoutMs)
      timer.unref?.()
      const cleanup = () => {
        clearTimeout(timer)
        this.off('frame', onFrame)
        this.#child?.off('error', fail)
        this.#child?.off('exit', onExit)
      }
      const fail = error => {
        if (settled) {
          this.emit('error', error)
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const onExit = (code, signal) => fail(new Error(`relay process exited before ready (${code ?? signal})`))
      const onFrame = frame => {
        if (frame?.type !== 'ready') return
        settled = true
        cleanup()
        resolve()
      }
      this.on('frame', onFrame)
      this.#child.once('error', fail)
      this.#child.once('exit', onExit)
      this.#readFrames().catch(fail)
      this.send(hello)
    })
  }

  async #readFrames() {
    for await (const line of this.#lines) {
      if (Buffer.byteLength(line) > this.#frameMaxBytes) throw new Error('relay frame exceeds maximum size')
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        throw new Error('relay output is not valid JSON')
      }
      this.emit('frame', frame)
    }
    if (!this.#closed) throw new Error('relay output closed unexpectedly')
  }

  send(frame) {
    if (!this.#child?.stdin?.writable) throw new Error('relay process is not writable')
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#lines?.close()
    this.#child?.stdin?.end()
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGTERM')
  }
}
