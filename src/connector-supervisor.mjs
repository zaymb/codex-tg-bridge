import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function createChannelStatusWriter(path) {
  const temporary = `${path}.${process.pid}.tmp`
  return async status => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }
}

export class ConnectorSupervisor {
  #command
  #args
  #env
  #spawn
  #statusWriter
  #clock
  #wait
  #reconnectInitialMs
  #reconnectMaxMs
  #heartbeatTimeoutMs
  #child = null
  #statusChain = Promise.resolve()
  #disengaged = false
  #engageResolve = null

  constructor({
    command,
    args = [],
    env = process.env,
    spawnImpl = spawn,
    statusWriter = async () => {},
    clock = Date.now,
    waitImpl = wait,
    reconnectInitialMs = 1_000,
    reconnectMaxMs = 20_000,
    heartbeatTimeoutMs = 20_000,
  }) {
    this.#command = command
    this.#args = args
    this.#env = env
    this.#spawn = spawnImpl
    this.#statusWriter = statusWriter
    this.#clock = clock
    this.#wait = waitImpl
    this.#reconnectInitialMs = reconnectInitialMs
    this.#reconnectMaxMs = reconnectMaxMs
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs
  }

  #writeStatus(status, fields = {}) {
    const value = {
      source: 'telegram',
      status,
      updatedAtMs: this.#clock(),
      ...fields,
    }
    this.#statusChain = this.#statusChain.then(() => this.#statusWriter(value))
    return this.#statusChain
  }

  #monitorOutput(child) {
    let connected = false
    let disengaged = false
    let lastHeartbeatAtMs = null
    let heartbeatTimer = null
    const errorLines = []
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
    stdout.on('line', line => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event?.event === 'local_connector_disengaged') {
        disengaged = true
        clearTimeout(heartbeatTimer)
        return
      }
      if (!['local_connector_ready', 'local_connector_heartbeat'].includes(event?.event)) return
      connected = true
      lastHeartbeatAtMs = this.#clock()
      this.#writeStatus('connected', {
        connectorPid: child.pid ?? null,
        lastHeartbeatAtMs,
        heartbeatExpiresAtMs: lastHeartbeatAtMs + this.#heartbeatTimeoutMs,
      })
      clearTimeout(heartbeatTimer)
      heartbeatTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        this.#writeStatus('disconnected', {
          connectorPid: child.pid ?? null,
          lastHeartbeatAtMs,
          reason: 'heartbeat_timeout',
        })
        child.kill('SIGTERM')
      }, this.#heartbeatTimeoutMs)
    })
    stderr.on('line', line => {
      errorLines.push(line.slice(0, 2_000))
      if (errorLines.length > 10) errorLines.shift()
    })
    return {
      connected: () => connected,
      disengaged: () => disengaged,
      lastError: () => errorLines.length > 0 ? errorLines.join('\n') : null,
      close() {
        clearTimeout(heartbeatTimer)
        stdout.close()
        stderr.close()
      },
    }
  }

  engage() {
    if (!this.#disengaged) return false
    this.#disengaged = false
    const resolve = this.#engageResolve
    this.#engageResolve = null
    resolve?.()
    return true
  }

  #waitForEngage(signal) {
    if (!this.#disengaged || signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        signal?.removeEventListener('abort', done)
        if (this.#engageResolve === done) this.#engageResolve = null
        resolve()
      }
      this.#engageResolve = done
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  async run({ signal } = {}) {
    let failedAttempts = 0
    while (!signal?.aborted) {
      await this.#writeStatus(failedAttempts === 0 ? 'connecting' : 'reconnecting', {
        attempt: failedAttempts + 1,
      })
      const child = this.#spawn(this.#command, this.#args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.#env,
        detached: true,
      })
      this.#child = child
      const monitor = this.#monitorOutput(child)
      const abort = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      signal?.addEventListener('abort', abort, { once: true })
      let exit
      try {
        exit = await childExit(child)
      } catch (error) {
        exit = { code: null, signal: null, error: error.message }
      } finally {
        signal?.removeEventListener('abort', abort)
        monitor.close()
        if (this.#child === child) this.#child = null
      }
      if (signal?.aborted) break

      if (exit.code === 78) {
        this.#disengaged = true
        await this.#writeStatus('disengaged', {
          connectorPid: child.pid ?? null,
          exitCode: exit.code,
          farewellObserved: monitor.disengaged(),
        })
        await this.#waitForEngage(signal)
        if (signal?.aborted) break
        failedAttempts = 0
        continue
      }

      failedAttempts = monitor.connected() ? 0 : failedAttempts + 1
      const exponent = Math.min(Math.max(0, failedAttempts - 1), 30)
      const nextRetryMs = Math.min(
        this.#reconnectMaxMs,
        this.#reconnectInitialMs * (2 ** exponent),
      )
      await this.#writeStatus('reconnecting', {
        connectorPid: child.pid ?? null,
        exitCode: exit.code,
        exitSignal: exit.signal,
        lastError: exit.error ?? monitor.lastError(),
        nextRetryMs,
      })
      await this.#wait(nextRetryMs, signal)
    }
    if (this.#child?.exitCode === null && this.#child?.signalCode === null) {
      this.#child.kill('SIGTERM')
    }
    await this.#statusChain
    await this.#writeStatus('stopped')
  }
}
