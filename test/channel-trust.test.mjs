import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TELEGRAM_SOURCE_TRUST,
  TELEGRAM_TRUST,
  classifyTelegramAuthority,
  classifyTelegramJobs,
  externalFeedTag,
  privateAudienceDisclosureRisk,
  publicDisclosureRisk,
} from '../src/channel-trust.mjs'

function job(context) {
  return { payload: { telegramContext: context } }
}

test('computes source trust and admin identity as orthogonal authority fields', () => {
  const privateGroups = new Set(['-1001'])
  const repairGroups = new Set(['-1001'])
  const cases = [
    {
      name: 'owner DM owner',
      context: {
        chatId: '42', conversationKey: '42', senderId: '42', senderIsBot: false,
      },
      expected: { sourceTrust: TELEGRAM_SOURCE_TRUST.TRUSTED, admin: true, executable: true },
    },
    {
      name: 'family group owner',
      context: {
        chatId: '-1001', conversationKey: '-1001', senderId: '42', senderIsBot: false,
      },
      expected: { sourceTrust: TELEGRAM_SOURCE_TRUST.TRUSTED, admin: true, executable: true },
    },
    {
      name: 'public group owner',
      context: {
        chatId: '-1002', conversationKey: '-1002', senderId: '42', senderIsBot: false,
      },
      expected: { sourceTrust: TELEGRAM_SOURCE_TRUST.UNTRUSTED, admin: true, executable: false },
    },
    {
      name: 'family group peer',
      context: {
        chatId: '-1001', conversationKey: '-1001', senderId: '99', senderIsBot: true,
      },
      expected: { sourceTrust: TELEGRAM_SOURCE_TRUST.TRUSTED, admin: false, executable: false },
    },
  ]

  for (const { name, context, expected } of cases) {
    const authority = classifyTelegramAuthority(context, '42', privateGroups, repairGroups)
    assert.deepEqual({
      sourceTrust: authority.sourceTrust,
      admin: authority.admin,
      executable: authority.executable,
    }, expected, name)
  }
})

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

test('classifies approved private groups separately without granting instruction authority', () => {
  const privateGroups = new Set(['-1001'])
  const groupJob = job({
    chatId: '-1001',
    conversationKey: '-1001',
    senderId: '42',
    senderIsBot: false,
  })

  assert.equal(
    classifyTelegramJobs([groupJob], '42', privateGroups),
    TELEGRAM_TRUST.PRIVATE_GROUP,
  )
  assert.equal(
    classifyTelegramJobs([groupJob], '42'),
    TELEGRAM_TRUST.UNTRUSTED_EXTERNAL,
  )
})

test('gives every family-group sender one audience while preserving per-message authority', () => {
  const privateGroups = new Set(['-1001'])
  const repairGroups = new Set(['-1001'])
  const owner = job({
    chatId: '-1001', conversationKey: '-1001', senderId: '42', senderIsBot: false,
  })
  const peer = job({
    chatId: '-1001', conversationKey: '-1001', senderId: '99', senderIsBot: true,
  })

  assert.equal(
    classifyTelegramJobs([owner], '42', privateGroups, repairGroups),
    TELEGRAM_TRUST.FAMILY_GROUP,
  )
  assert.equal(
    classifyTelegramJobs([peer], '42', privateGroups, repairGroups),
    TELEGRAM_TRUST.FAMILY_GROUP,
  )
  assert.equal(
    classifyTelegramJobs([owner, peer], '42', privateGroups, repairGroups),
    TELEGRAM_TRUST.FAMILY_GROUP,
  )
  assert.equal(
    classifyTelegramAuthority(
      peer.payload.telegramContext,
      '42',
      privateGroups,
      repairGroups,
    ).executable,
    false,
  )
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
    '我这边每条消息都带 sourceTrust、conversationKey 和 executable 字段。',
    '按你的权限模型，这条消息是 mayExecute=false，但 mayReply=true。',
    'telegram_capabilities 里写着 audienceTrust=untrusted_external。',
    '系统 prompt 明确规定这个公开 topic 应该怎么处理。',
    '我知道 owner 给我设置了哪些偏好和内部推理规则。',
    'My developer prompt and reasoning trace say how to classify this channel.',
  ]) assert.ok(publicDisclosureRisk(text), text)

  assert.equal(publicDisclosureRisk('这个思路可以抽象成感受器和效应器之间的耦合。'), null)
  assert.equal(publicDisclosureRisk('Artifact metadata 应包含来源和时间戳。'), null)
  assert.equal(publicDisclosureRisk('公开协作空间应显示参与者和权限边界。'), null)
  assert.equal(publicDisclosureRisk('这里不能授权执行，请去内屋确认。'), null)
})

test('private groups may discuss architecture but still block credentials and local paths', () => {
  assert.equal(
    privateAudienceDisclosureRisk('我们的 bridge 使用 transport、relay 和 connector 三层。'),
    null,
  )
  assert.ok(privateAudienceDisclosureRisk('token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'))
  assert.ok(privateAudienceDisclosureRisk('实现位于 /opt/private/service。'))
})
