import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ControlClient } from '../src/control-client.mjs'
import { ControlServer } from '../src/control-server.mjs'
import { StateStore } from '../src/state-store.mjs'

class FakeDispatcher {
  actions = []

  async enqueueExternalAction(action) {
    this.actions.push(action)
    return { ...action, status: 'sent', telegramMessageId: String(100 + this.actions.length) }
  }
}

class FakeAttachmentStore {
  paths = []

  async assertExportPath(path) {
    this.paths.push(path)
    if (path.includes('outside')) throw new Error('export file is outside configured export roots')
    return `/canonical${path}`
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bridge-control-'))
  const socketPath = join(dir, 'action.sock')
  const state = StateStore.open(':memory:')
  state.upsertApprovedChat({
    conversationKey: '-100123:7',
    telegramChatId: '-100123',
    alias: 'sandbox-topic',
    title: 'Sandbox Topic',
    kind: 'forum_topic',
    nowMs: 1,
  })
  state.upsertApprovedChat({
    conversationKey: '42',
    telegramChatId: '42',
    alias: 'owner',
    title: 'Owner',
    kind: 'private',
    nowMs: 1,
  })
  const dispatcher = new FakeDispatcher()
  const attachmentStore = new FakeAttachmentStore()
  const server = new ControlServer({
    socketPath,
    stateStore: state,
    dispatcher,
    attachmentStore,
    ownerUserId: '42',
  })
  await server.start()
  const client = await ControlClient.connect({ socketPath, requestTimeoutMs: 1_000 })
  return { dir, socketPath, state, dispatcher, attachmentStore, server, client }
}

test('sends, replies, edits, deletes, reacts, and rolls dice only in an approved aliased chat', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  await setup.client.request('send_text', { target: 'sandbox-topic', text: 'hello' }, { actionId: 'action-1' })
  await setup.client.request('reply', { target: 'sandbox-topic', messageId: '55', text: 'reply' }, { actionId: 'action-2' })
  await setup.client.request('edit_own_message', { target: 'sandbox-topic', messageId: '56', text: 'edit' }, { actionId: 'action-3' })
  await setup.client.request('delete_own_message', { target: 'sandbox-topic', messageId: '56' }, { actionId: 'action-4' })
  await setup.client.request('react', { target: 'sandbox-topic', messageId: '55', reaction: { type: 'emoji', emoji: '👍' } }, { actionId: 'action-5' })
  await setup.client.request('send_dice', { target: 'sandbox-topic', messageId: '55', emoji: '🎯' }, { actionId: 'action-6' })

  assert.deepEqual(setup.dispatcher.actions.map(action => action.actionType), [
    'send_text', 'reply', 'edit_own_message', 'delete_own_message', 'react', 'send_dice',
  ])
  assert.ok(setup.dispatcher.actions.every(action => action.conversationKey === '-100123:7'))
  assert.ok(setup.dispatcher.actions.every(action => action.payload.chatId === '-100123'))
  assert.ok(setup.dispatcher.actions.every(action => action.payload.threadId === '7'))
  assert.deepEqual(setup.dispatcher.actions.at(-1).payload, {
    chatId: '-100123',
    threadId: '7',
    emoji: '🎯',
    replyToMessageId: '55',
  })
})

test('rejects arbitrary chat IDs and invalid action IDs', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  await assert.rejects(
    setup.client.request('send_text', { target: '-100999', text: 'no' }, { actionId: 'action-1' }),
    /unknown or unapproved Telegram target/,
  )
  await assert.rejects(
    setup.client.request('send_text', { target: 'sandbox-topic', text: 'no' }, { actionId: '../../bad' }),
    /invalid actionId/,
  )
  assert.equal(setup.dispatcher.actions.length, 0)
})

test('validates file paths through the configured export roots before dispatch', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())
  const exportDir = join(setup.dir, 'exports')
  await mkdir(exportDir)
  const file = join(exportDir, 'report.txt')
  await writeFile(file, 'report')

  await setup.client.request('send_file', {
    target: 'owner',
    path: file,
    kind: 'document',
    caption: 'Report',
  }, { actionId: 'file-action' })
  assert.equal(setup.dispatcher.actions[0].payload.path, `/canonical${file}`)

  await assert.rejects(
    setup.client.request('send_file', {
      target: 'owner',
      path: '/outside/secret',
      kind: 'document',
    }, { actionId: 'bad-file-action' }),
    /outside configured export roots/,
  )
})

test('lists approved chats without exposing Telegram credentials', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  const result = await setup.client.request('list_chats', {}, { actionId: 'list-action' })
  assert.deepEqual(result, [{
    alias: 'owner',
    conversationKey: '42',
    title: 'Owner',
    kind: 'private',
  }, {
    alias: 'sandbox-topic',
    conversationKey: '-100123:7',
    title: 'Sandbox Topic',
    kind: 'forum_topic',
  }])
})

test('blocks sensitive public text and public file export while preserving owner DM output', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  await assert.rejects(
    setup.client.request('send_text', {
      target: 'sandbox-topic',
      text: 'Our relay runs from /opt/private/relay with BRIDGE_DB_PATH set.',
    }, { actionId: 'sensitive-public' }),
    /blocked by the disclosure guard/,
  )
  await assert.rejects(
    setup.client.request('send_file', {
      target: 'sandbox-topic',
      path: '/tmp/report.txt',
    }, { actionId: 'public-file' }),
    /files can only be sent to the owner DM/,
  )
  await setup.client.request('send_text', {
    target: 'owner',
    text: 'Internal path: /opt/private/relay',
  }, { actionId: 'owner-detail' })
  assert.equal(setup.dispatcher.actions.at(-1).conversationKey, '42')
})

test('rejects oversized JSONL frames without crashing other clients', async t => {
  const setup = await fixture()
  t.after(() => setup.client.close())
  t.after(() => setup.server.close())
  t.after(() => setup.state.close())

  await assert.rejects(
    setup.client.request('send_text', { target: 'sandbox-topic', text: 'x'.repeat(70_000) }, { actionId: 'huge-action' }),
    /frame exceeds 65536 bytes|connection closed/,
  )

  const second = await ControlClient.connect({ socketPath: setup.socketPath, requestTimeoutMs: 1_000 })
  t.after(() => second.close())
  assert.equal((await second.request('list_chats', {}, { actionId: 'list-after-huge' })).length, 2)
})
