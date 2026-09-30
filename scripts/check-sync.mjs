#!/usr/bin/env node
/**
 * 一刻 —— 对着**真实后端**跑一遍同步接口。
 *
 * 为什么要有这个脚本（而不是靠单测）：
 *   单测跑在 Node 的 SQLite 上，它证明不了「部署出去的那一份」也对。
 *   而这里验的恰恰是本地测不出来的那几件事：
 *     · 鉴权与路由真的生效（令牌 → userId）
 *     · 幂等：同一个 mutationId 重复推送只生效一次
 *     · 并发竞态：两台设备同时新建同一条记录，**不能有一方以为成功**
 *     · 乐观并发：版本对不上时必须报冲突，而不是覆盖
 *     · 软删除：删除写的是 deleted_at_utc，记录本身还在（Tombstone 能同步）
 *   这和 scripts/check-installable.mjs 是同一类东西 —— 只在真环境里才有意义。
 *
 * 用法（地址和令牌从参数或环境变量读，脚本本身不含任何密钥）：
 *
 *   node scripts/check-sync.mjs --url=https://xxx.workers.dev --token=yyy
 *   YIKE_SYNC_URL=https://xxx.workers.dev YIKE_SYNC_TOKEN=yyy node scripts/check-sync.mjs
 *
 * 它会在你的账号下建几条**测试记录**，跑完就地软删除。
 * 注意：本项目的红线是「删除永远是软删除」，所以这些记录会以 Tombstone
 * 的形式留在库里（界面上看不见）。不会碰你已有的任何记录。
 *
 * 退出码：全部通过 0，有任何一项失败 1。
 */

const flags = new Map()
for (const arg of process.argv.slice(2)) {
  const index = arg.indexOf('=')
  flags.set(index === -1 ? arg : arg.slice(0, index), index === -1 ? true : arg.slice(index + 1))
}

const BASE = String(flags.get('--url') ?? process.env.YIKE_SYNC_URL ?? '').replace(/\/+$/, '')
const TOKEN = String(flags.get('--token') ?? process.env.YIKE_SYNC_TOKEN ?? '')

if (BASE === '' || TOKEN === '') {
  process.stderr.write(
    [
      '缺少地址或令牌。用法：',
      '',
      '  node scripts/check-sync.mjs --url=https://xxx.workers.dev --token=yyy',
      '',
      '（地址和令牌就是部署脚本最后给你的那两样东西。）',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

// ---------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------

let passed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failures.push(name)
    process.stdout.write(`  ✗ ${name}\n`)
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail)}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}\n`)
}

async function call(path, { method = 'POST', body, token = TOKEN } = {}) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  // GET/HEAD 不允许带 body —— 即使值是 undefined 也不行，
  // 所以这里只在真有 body 时才把它放进 init，而不是无脑塞一个 undefined。
  const init = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)

  const response = await fetch(`${BASE}${path}`, init)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // 有些响应本来就没有 JSON 体（比如 204），不当成失败
  }
  return { status: response.status, body: payload }
}

const nowIso = () => new Date().toISOString()
const today = () => nowIso().slice(0, 10)

/** 每次跑用不同的 id，重复执行不会互相干扰 */
const run = Math.random().toString(16).slice(2, 10)
const idFor = (suffix) => `smoke-${run}-${suffix}`
const mutationFor = (suffix) => `smoke-m-${run}-${suffix}`

function createPayload(content) {
  return {
    type: 'idea',
    content,
    createdAtUtc: nowIso(),
    createdTimezone: 'Asia/Shanghai',
    createdLocalDate: today(),
    updatedAtUtc: nowIso(),
    updatedTimezone: 'Asia/Shanghai',
  }
}

// ---------------------------------------------------------------
// 开始
// ---------------------------------------------------------------

process.stdout.write(`\n一刻 · 同步后端现场校验\n  地址：${BASE}\n`)

section('0. 连通性与鉴权')

const health = await call('/api/health', { method: 'GET', token: null })
check('健康检查不需要令牌', health.status === 200 && health.body?.ok === true, health)

const noToken = await call('/api/sync/pull', { body: {}, token: null })
check('不带令牌被拒（401）', noToken.status === 401, noToken)

const badToken = await call('/api/sync/pull', { body: {}, token: 'not-a-real-token' })
check('令牌错误被拒（401）', badToken.status === 401, badToken)

const me = await call('/api/me', { method: 'GET' })
check('令牌能换到账号（/api/me）', me.status === 200 && typeof me.body?.userId === 'string', me)

const badBody = await call('/api/sync/mutate', { body: { nonsense: true } })
check('请求体不合法回 400（不是 500）', badBody.status === 400, badBody)

// ---------------------------------------------------------------
section('1. 新建 + 幂等')

const recordA = idFor('a')
const mutationA = mutationFor('a')

const created = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationA,
    recordId: recordA,
    operation: 'create',
    expectedVersion: null,
    payload: createPayload('同步自测 · 第一条'),
  },
})
check('新建成功，版本为 1', created.body?.status === 'applied' && created.body?.version === 1, created)

const repeated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationA,
    recordId: recordA,
    operation: 'create',
    expectedVersion: null,
    payload: createPayload('这条内容不该被写进去'),
  },
})
check(
  '同一个 mutationId 重推 → already_applied，内容没被改',
  repeated.body?.status === 'already_applied' &&
    repeated.body?.version === 1 &&
    repeated.body?.record?.content === '同步自测 · 第一条',
  repeated,
)

// ---------------------------------------------------------------
section('2. 乐观并发')

const updated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('a-upd'),
    recordId: recordA,
    operation: 'update',
    expectedVersion: 1,
    payload: { content: '同步自测 · 改过一次', updatedAtUtc: nowIso(), updatedTimezone: 'Asia/Shanghai' },
  },
})
check('版本对得上 → 更新成功，版本变 2', updated.body?.status === 'applied' && updated.body?.version === 2, updated)

const stale = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('a-stale'),
    recordId: recordA,
    operation: 'update',
    expectedVersion: 1,
    payload: { content: '拿旧版本去覆盖', updatedAtUtc: nowIso() },
  },
})
check('版本对不上 → version_conflict', stale.body?.status === 'version_conflict', stale)
check(
  '冲突时**没有**覆盖已有内容',
  stale.body?.record?.content === '同步自测 · 改过一次',
  stale.body?.record?.content,
)

// ---------------------------------------------------------------
section('3. 并发竞态（这条是 changes() 判据的回归测试）')

// 两台设备同时新建同一条记录：同一个 recordId，两个不同的 mutationId。
// 期望：最多一方 applied，另一方必须是 version_conflict。
//
// 如果幂等记录用 `where exists(...)` 判定，输的那一方也会被记成「已应用」，
// 而它带的内容被丢掉了 —— 客户端以为推送成功，之后 Pull 回来覆盖本地，
// 就是静默丢数据。所以这一项失败意味着**必须回滚部署**。
const raceRecord = idFor('race')
const raceInputs = ['甲设备写的', '乙设备写的'].map((content, index) => ({
  mutationId: mutationFor(`race-${index}`),
  recordId: raceRecord,
  operation: 'create',
  expectedVersion: null,
  payload: createPayload(content),
}))

const raceResults = await Promise.all(
  raceInputs.map((body) => call('/api/sync/mutate', { body })),
)

const raceStatuses = raceResults.map((item) => item.body?.status)
const appliedCount = raceStatuses.filter((status) => status === 'applied').length
const conflictCount = raceStatuses.filter((status) => status === 'version_conflict').length

check(
  '并发新建：只有一方 applied',
  appliedCount === 1,
  raceStatuses,
)
check(
  '并发新建：另一方明确报冲突（没有被静默吞掉）',
  conflictCount === 1,
  raceStatuses,
)

const raceWinner = raceResults.find((item) => item.body?.status === 'applied')
const raceRead = await call(`/api/sync/record?id=${encodeURIComponent(raceRecord)}`, { method: 'GET' })
check(
  '并发新建：库里留下的正是胜出那一方的内容',
  raceRead.body?.record?.content === raceWinner?.body?.record?.content,
  { stored: raceRead.body?.record?.content, winner: raceWinner?.body?.record?.content },
)

// ---------------------------------------------------------------
section('4. 软删除与 Tombstone')

const deleted = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('a-del'),
    recordId: recordA,
    operation: 'delete',
    expectedVersion: 2,
    payload: { deletedAtUtc: nowIso(), updatedAtUtc: nowIso() },
  },
})
check(
  '删除写的是 deletedAtUtc（不是物理删除）',
  deleted.body?.status === 'applied' && typeof deleted.body?.record?.deletedAtUtc === 'string',
  deleted,
)

const pulled = await call('/api/sync/pull', { body: {} })
const pulledIds = (pulled.body?.records ?? []).map((item) => item.id)
check(
  'Pull 能拉到软删除的记录（Tombstone 会同步给其它设备）',
  pulledIds.includes(recordA),
  { count: pulledIds.length, lookingFor: recordA },
)

const createdStays = (pulled.body?.records ?? []).find((item) => item.id === recordA)
check(
  'createdAtUtc 没有被任何一次写入改动',
  createdStays?.createdAtUtc === created.body?.record?.createdAtUtc,
  { now: createdStays?.createdAtUtc, atCreate: created.body?.record?.createdAtUtc },
)

// ---------------------------------------------------------------
section('5. 清理本次测试记录')

// 红线：不做物理删除，所以这里也只软删除。留下的是 Tombstone，
// 界面上看不见，也不会影响你已有的记录。
const leftovers = [raceRecord]
for (const recordId of leftovers) {
  const read = await call(`/api/sync/record?id=${encodeURIComponent(recordId)}`, { method: 'GET' })
  const version = read.body?.record?.version
  if (typeof version !== 'number') continue
  const result = await call('/api/sync/mutate', {
    body: {
      mutationId: mutationFor(`cleanup-${recordId}`),
      recordId,
      operation: 'delete',
      expectedVersion: version,
      payload: { deletedAtUtc: nowIso(), updatedAtUtc: nowIso() },
    },
  })
  check(`测试记录已软删除：${recordId}`, result.body?.status === 'applied', result.body)
}

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------

process.stdout.write('\n' + '─'.repeat(64) + '\n')
if (failures.length === 0) {
  process.stdout.write(`  全部通过（${passed} 项）—— 后端真的能同步，不是推断的。\n\n`)
  process.exit(0)
}
process.stdout.write(`  ${passed} 项通过，${failures.length} 项失败：\n`)
for (const name of failures) process.stdout.write(`    · ${name}\n`)
process.stdout.write('\n  同步的正确性优先于一切，失败项请先查清再让设备同步。\n\n')
process.exit(1)
