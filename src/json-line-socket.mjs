import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

export const MAX_FRAME_BYTES = 65_536

export class JsonLineSocketServer {
  #socketPath
  #handler
  #maxFrameBytes
  #server = null
  #connections = new Set()

  constructor({ socketPath, handler, maxFrameBytes = MAX_FRAME_BYTES }) {
    this.#socketPath = socketPath
    this.#handler = handler
    this.#maxFrameBytes = maxFrameBytes
  }

  async start() {
    if (this.#server) return
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o750 })
    try {
      const existing = lstatSync(this.#socketPath)
      if (!existing.isSocket()) throw new Error(`refusing to replace non-socket path: ${this.#socketPath}`)
      unlinkSync(this.#socketPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    this.#server = createServer(socket => {
      this.#connections.add(socket)
      let buffer = Buffer.alloc(0)
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data])
        if (buffer.length > this.#maxFrameBytes && !buffer.includes(0x0a)) {
          socket.destroy(new Error(`frame exceeds ${this.#maxFrameBytes} bytes`))
          return
        }
        let newline
        while ((newline = buffer.indexOf(0x0a)) !== -1) {
          const frame = buffer.subarray(0, newline)
          buffer = buffer.subarray(newline + 1)
          if (frame.length === 0) continue
          if (frame.length > this.#maxFrameBytes) {
            socket.destroy(new Error(`frame exceeds ${this.#maxFrameBytes} bytes`))
            return
          }
          this.#handleFrame(socket, frame)
        }
      })
      socket.on('close', () => this.#connections.delete(socket))
      socket.on('error', () => {})
    })
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.#socketPath, resolve)
    })
    chmodSync(this.#socketPath, 0o660)
  }

  async #handleFrame(socket, frame) {
    let request
    try {
      request = JSON.parse(frame.toString('utf8'))
      if (!request || typeof request !== 'object' || request.id === undefined) {
        throw new Error('request must be an object with an id')
      }
      const result = await this.#handler(request)
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
    } catch (error) {
      const id = request?.id ?? null
      const response = { id, error: { code: 'INVALID_REQUEST', message: error.message } }
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`)
    }
  }

  async close() {
    if (!this.#server) return
    for (const socket of this.#connections) socket.destroy()
    const server = this.#server
    this.#server = null
    await new Promise(resolve => server.close(resolve))
    try { unlinkSync(this.#socketPath) } catch {}
  }
}
