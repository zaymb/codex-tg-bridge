import { EventEmitter } from 'node:events'
import { isAbsolute } from 'node:path'
import WebSocket from 'ws'

import { validateContract } from './contract.mjs'

const DELTA_NOTIFICATIONS = Object.freeze([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
])

export class AppServerRpcError extends Error {
  constructor(message, { code, data, method, requestId } = {}) {
    super(message)
    this.name = 'AppServerRpcError'
    this.code = code
    this.data = data
    this.method = method
    this.requestId = requestId
  }
}

export class AppServerProtocolError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'AppServerProtocolError'
  }
}

export class AppServerDisconnectedError extends Error {
  constructor(message = 'Codex app-server disconnected') {
    super(message)
    this.name = 'AppServerDisconnectedError'
  }
}

export class AppServerClient extends EventEmitter {
  static async connect({
    socketPath,
    contract,
    requestTimeoutMs = 30_000,
    WebSocketImpl = WebSocket,
  }) {
    validateContract(contract)
    if (!isAbsolute(socketPath)) throw new Error('app-server socketPath must be absolute')
    const socket = new WebSocketImpl(`ws+unix://${socketPath}:/`)
    const client = new AppServerClient({ socket, contract, requestTimeoutMs })
    await client.#open()
    try {
      client.initializeResult = await client.request('initialize', {
        clientInfo: {
          name: 'tg_engage_bridge',
          title: 'TG Engage Codex Bridge',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: DELTA_NOTIFICATIONS,
        },
      })
      client.notify('initialized', {})
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  #socket
  #contract
  #requestTimeoutMs
  #nextRequestId = 1
  #pending = new Map()
  #serverRequests = new Set()
  #respondedServerRequests = new Set()
  #opened = false
  #closed = false
  #closePromise = null
  initializeResult = null

  constructor({ socket, contract, requestTimeoutMs }) {
    super()
    this.#socket = socket
    this.#contract = contract
    this.#requestTimeoutMs = requestTimeoutMs
  }

  get closed() {
    return this.#closed
  }

  get contract() {
    return this.#contract
  }

  #open() {
    return new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        this.#opened = true
        this.#socket.on('message', data => this.#handleFrame(data))
        this.#socket.on('close', (code, reason) => this.#handleClose(code, reason))
        this.#socket.on('error', error => this.#handleSocketError(error))
        resolve()
      }
      const onError = error => {
        cleanup()
        this.#closed = true
        reject(new AppServerDisconnectedError(`failed to connect to Codex app-server: ${error.message}`))
      }
      const cleanup = () => {
        this.#socket.off('open', onOpen)
        this.#socket.off('error', onError)
      }
      this.#socket.once('open', onOpen)
      this.#socket.once('error', onError)
    })
  }

  #send(message) {
    if (this.#closed || !this.#opened || this.#socket.readyState !== this.#socket.OPEN) {
      throw new AppServerDisconnectedError()
    }
    this.#socket.send(JSON.stringify(message))
  }

  request(method, params = {}, { timeoutMs = this.#requestTimeoutMs } = {}) {
    if (this.#closed) return Promise.reject(new AppServerDisconnectedError())
    const id = this.#nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AppServerRpcError(`Codex app-server request timed out: ${method}`, {
          code: 'TIMEOUT',
          method,
          requestId: id,
        }))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params = {}) {
    this.#send({ method, params })
  }

  respond(id, result, error = null) {
    const key = String(id)
    if (this.#respondedServerRequests.has(key)) {
      throw new AppServerProtocolError(`server request ${key} was already responded to`)
    }
    if (!this.#serverRequests.has(key)) {
      throw new AppServerProtocolError(`unknown server request ${key}`)
    }
    this.#serverRequests.delete(key)
    this.#respondedServerRequests.add(key)
    if (error) this.#send({ id, error })
    else this.#send({ id, result })
  }

  #handleFrame(data) {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch (cause) {
      this.#abort(new AppServerProtocolError('Codex app-server sent malformed JSON', { cause }))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#abort(new AppServerProtocolError('Codex app-server sent a non-object frame'))
      return
    }

    if (message.method !== undefined && message.id !== undefined) {
      const key = String(message.id)
      if (this.#serverRequests.has(key) || this.#respondedServerRequests.has(key)) {
        this.#abort(new AppServerProtocolError(`duplicate server request id ${key}`))
        return
      }
      this.#serverRequests.add(key)
      this.emit('request', { id: message.id, method: message.method, params: message.params ?? {} })
      this.emit(`request:${message.method}`, { id: message.id, method: message.method, params: message.params ?? {} })
      return
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) {
        this.#abort(new AppServerProtocolError(`unexpected response id ${message.id}`))
        return
      }
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (message.error) {
        pending.reject(new AppServerRpcError(message.error.message ?? 'Codex app-server request failed', {
          code: message.error.code,
          data: message.error.data,
          method: pending.method,
          requestId: message.id,
        }))
      } else if (Object.hasOwn(message, 'result')) {
        pending.resolve(message.result)
      } else {
        pending.reject(new AppServerProtocolError(`response ${message.id} has neither result nor error`))
      }
      return
    }

    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params ?? {} }
      this.emit('notification', notification)
      this.emit(`notification:${message.method}`, notification.params)
      return
    }

    this.#abort(new AppServerProtocolError('Codex app-server sent an unrecognized frame'))
  }

  #handleSocketError(error) {
    if (this.#closed) return
    this.#abort(new AppServerDisconnectedError(`Codex app-server socket error: ${error.message}`))
  }

  #handleClose(code, reason) {
    if (this.#closed) return
    this.#closed = true
    const suffix = reason?.length ? `: ${reason.toString()}` : ''
    const error = new AppServerDisconnectedError(`Codex app-server closed (${code})${suffix}`)
    this.#rejectPending(error)
    this.emit('close', error)
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #abort(error) {
    if (this.#closed) return
    this.#closed = true
    this.#rejectPending(error)
    this.emit('protocolError', error)
    this.#socket.terminate()
  }

  close() {
    if (this.#closePromise) return this.#closePromise
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#rejectPending(new AppServerDisconnectedError('Codex app-server client closed'))
    this.#closePromise = new Promise(resolve => {
      if (this.#socket.readyState === this.#socket.CLOSED) {
        resolve()
        return
      }
      this.#socket.once('close', resolve)
      this.#socket.close(1000, 'bridge shutdown')
    })
    return this.#closePromise
  }
}
