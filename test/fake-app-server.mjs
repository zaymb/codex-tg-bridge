import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

export async function startFakeAppServer({
  onMessage,
  userAgent = 'Codex Desktop/0.143.0 (Mac OS 26.5.0; x86_64) dumb (tg_engage_bridge; 0.1.0)',
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-app-server-'))
  const socketPath = join(dir, 'app.sock')
  const httpServer = createServer()
  const webSocketServer = new WebSocketServer({ server: httpServer })
  const messages = []
  const upgradeHeaders = []
  const waiters = []
  let socket = null

  webSocketServer.on('connection', (client, request) => {
    upgradeHeaders.push(request.headers)
    socket = client
    client.on('message', async data => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(message)) {
          waiters[index].resolve(message)
          waiters.splice(index, 1)
        }
      }
      if (message.method === 'initialize' && message.id !== undefined) {
        client.send(JSON.stringify({
          id: message.id,
          result: { userAgent, platformFamily: 'unix', platformOs: 'linux' },
        }))
      }
      await onMessage?.(message, {
        send: value => client.send(JSON.stringify(value)),
        sendRaw: value => client.send(value),
        close: (code = 1011, reason = 'fake close') => client.close(code, reason),
      })
    })
  })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(socketPath, resolve)
  })

  return {
    socketPath,
    messages,
    upgradeHeaders,
    send(message) {
      if (!socket) throw new Error('fake app-server has no connected client')
      socket.send(JSON.stringify(message))
    },
    sendRaw(value) {
      if (!socket) throw new Error('fake app-server has no connected client')
      socket.send(value)
    },
    waitForMessage(predicate, timeoutMs = 2_000) {
      const existing = messages.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiters.push(waiter)
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('timed out waiting for fake app-server message'))
        }, timeoutMs)
        timeout.unref?.()
        waiter.resolve = message => {
          clearTimeout(timeout)
          resolve(message)
        }
      })
    },
    async close() {
      for (const client of webSocketServer.clients) client.terminate()
      await new Promise(resolve => webSocketServer.close(resolve))
      await new Promise(resolve => httpServer.close(resolve))
    },
  }
}
