import { createConnection } from 'node:net'

import { MAX_FRAME_BYTES } from './json-line-socket.mjs'

export class ControlProtocolError extends Error {
  constructor(message, { code = 'CONTROL_ERROR' } = {}) {
    super(message)
    this.name = 'ControlProtocolError'
    this.code = code
  }
}

export class ControlClient {
  static async connect({ socketPath, requestTimeoutMs = 10_000, maxFrameBytes = MAX_FRAME_BYTES }) {
    const socket = createConnection(socketPath)
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new ControlClient({ socket, requestTimeoutMs, maxFrameBytes })
  }

  #socket
  #requestTimeoutMs
  #maxFrameBytes
  #nextId = 1
  #pending = new Map()
  #buffer = Buffer.alloc(0)
  #closed = false

  constructor({ socket, requestTimeoutMs, maxFrameBytes }) {
    this.#socket = socket
    this.#requestTimeoutMs = requestTimeoutMs
    this.#maxFrameBytes = maxFrameBytes
    socket.on('data', data => this.#handleData(data))
    socket.on('close', () => this.#handleClose())
    socket.on('error', error => this.#handleClose(error))
  }

  request(action, params = {}, { actionId } = {}) {
    if (this.#closed) return Promise.reject(new ControlProtocolError('control connection closed'))
    const id = this.#nextId++
    const frame = Buffer.from(`${JSON.stringify({ id, action, actionId, params })}\n`)
    if (frame.length > this.#maxFrameBytes) {
      return Promise.reject(new ControlProtocolError(`frame exceeds ${this.#maxFrameBytes} bytes`))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ControlProtocolError(`control request timed out: ${action}`, { code: 'TIMEOUT' }))
      }, this.#requestTimeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      this.#socket.write(frame)
    })
  }

  #handleData(data) {
    this.#buffer = Buffer.concat([this.#buffer, data])
    if (this.#buffer.length > this.#maxFrameBytes && !this.#buffer.includes(0x0a)) {
      this.#socket.destroy()
      return
    }
    let newline
    while ((newline = this.#buffer.indexOf(0x0a)) !== -1) {
      const frame = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      let response
      try { response = JSON.parse(frame.toString('utf8')) } catch {
        this.#socket.destroy()
        return
      }
      const pending = this.#pending.get(response.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.#pending.delete(response.id)
      if (response.error) {
        pending.reject(new ControlProtocolError(response.error.message, { code: response.error.code }))
      } else {
        pending.resolve(response.result)
      }
    }
  }

  #handleClose(error = null) {
    if (this.#closed) return
    this.#closed = true
    const failure = new ControlProtocolError(error?.message || 'control connection closed')
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(failure)
    }
    this.#pending.clear()
  }

  close() {
    if (this.#closed) return
    this.#socket.end()
    this.#handleClose()
  }
}
