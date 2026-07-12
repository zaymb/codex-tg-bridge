import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PUBLIC_DISCLOSURE_NOTICE,
  TELEGRAM_TRUST,
  classifyTelegramJobs,
  externalFeedTag,
  guardTelegramOutput,
  publicDisclosureRisk,
} from '../src/channel-trust.mjs'

function job(context) {
  return { payload: { telegramContext: context } }
}

test('trusts only an authenticated owner private-chat batch', () => {
  const owner = job({
    chatId: '42',
    conversationKey: '42',
    senderId: '42',
    senderIsBot: false,
  })
  assert.equal(classifyTelegramJobs([owner], '42'), TELEGRAM_TRUST.OWNER_DM)
  assert.equal(classifyTelegramJobs([
    job({ ...owner.payload.telegramContext, chatId: '-1001', conversationKey: '-1001' }),
  ], '42'), TELEGRAM_TRUST.UNTRUSTED_EXTERNAL)
  assert.equal(classifyTelegramJobs([
    job({ ...owner.payload.telegramContext, senderId: '99' }),
  ], '42'), TELEGRAM_TRUST.UNTRUSTED_EXTERNAL)
  assert.equal(classifyTelegramJobs([owner, job({
    chatId: '-1001', conversationKey: '-1001', senderId: '42', senderIsBot: false,
  })], '42'), TELEGRAM_TRUST.UNTRUSTED_EXTERNAL)
})

test('marks every Telegram turn as an external feed with an explicit trust tier', () => {
  assert.equal(
    externalFeedTag(TELEGRAM_TRUST.UNTRUSTED_EXTERNAL),
    '[EXTERNAL_FEED][source=telegram][trust=untrusted_external]',
  )
})

test('blocks concrete private architecture and credential disclosures in public output', () => {
  for (const text of [
    'Our bridge runs from /opt/private/service with BRIDGE_DB_PATH configured.',
    '我的 transport 在这台机器上通过 systemd 部署。',
    'token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    '```sh\ncat ~/.ssh/config\n```',
  ]) assert.ok(publicDisclosureRisk(text), text)

  assert.equal(publicDisclosureRisk('这个思路可以抽象成感受器和效应器之间的耦合。'), null)
})

test('replaces unsafe public text but never rewrites owner-DM output or reactions', () => {
  const output = {
    action: 'send',
    skipped: false,
    finalText: 'Our relay lives at /opt/private/relay.',
    responses: [
      { messageId: '1', action: 'reply', text: 'CODEX_SECRET_PATH is internal.' },
      { messageId: '2', action: 'react', text: '👍' },
    ],
    reason: 'details',
  }
  const guarded = guardTelegramOutput(output, TELEGRAM_TRUST.UNTRUSTED_EXTERNAL)
  assert.equal(guarded.finalText, PUBLIC_DISCLOSURE_NOTICE)
  assert.equal(guarded.responses[0].text, PUBLIC_DISCLOSURE_NOTICE)
  assert.equal(guarded.responses[1].text, '👍')
  assert.deepEqual(guardTelegramOutput(output, TELEGRAM_TRUST.OWNER_DM), output)
})
