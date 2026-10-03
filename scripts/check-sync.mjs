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
 *     · 第四种类型 log 与不可变字段 parentId（0003 迁移之后才有的）
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
section('5. 进展（log）与 parentId —— 大事详情里的逐条记录')

// 这一组验的是 0003 迁移上线之后，**部署出去的那份 Worker** 真的认这四种类型。
// 本地单测跑在 Node 的 SQLite 上，证明不了线上那份也对，而这里正是
// 「本地测不出来的一层」。
//
// 顺带说明为什么 `type` 要在展开之后写：createPayload() 里默认是 'idea'，
// 后面的键覆盖前面的，这样读起来比另写一个 helper 更直白。
const parentProject = idFor('log-parent')
const parentCreated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log-parent'),
    recordId: parentProject,
    operation: 'create',
    expectedVersion: null,
    payload: {
      ...createPayload('同步自测 · 进展的父级大事'),
      type: 'project',
      progress: 20,
      deadlineLocalDate: '2026-12-31',
    },
  },
})
check(
  '大事能带 progress / deadline 新建',
  parentCreated.body?.record?.progress === 20 &&
    parentCreated.body?.record?.deadlineLocalDate === '2026-12-31',
  parentCreated.body?.record,
)

const logRecord = idFor('log')
const logCreated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log'),
    recordId: logRecord,
    operation: 'create',
    expectedVersion: null,
    payload: {
      ...createPayload('同步自测 · 一条进展'),
      type: 'log',
      parentId: parentProject,
      progress: 40,
    },
  },
})
check(
  'log 类型被接受（0003 之后才有的第四种类型）',
  logCreated.body?.status === 'applied' && logCreated.body?.record?.type === 'log',
  logCreated.body,
)
check('进展的 parentId 原样写入', logCreated.body?.record?.parentId === parentProject, {
  got: logCreated.body?.record?.parentId,
  want: parentProject,
})
check('进展的 progress 原样写入（=40）', logCreated.body?.record?.progress === 40, logCreated.body?.record?.progress)
check('进展不该有截止日', logCreated.body?.record?.deadlineLocalDate === null, logCreated.body?.record?.deadlineLocalDate)

// 不可变字段：更新时 payload 里塞一个**别的** parentId，库里必须纹丝不动。
// 如果这一项红了，说明触发器 records_created_fields_immutable 没生效，
// 或者 Worker 的 update 路径错误地把 parent_id 放进了 SET。
const logUpdated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log-upd'),
    recordId: logRecord,
    operation: 'update',
    expectedVersion: 1,
    payload: {
      content: '同步自测 · 进展改过内容',
      parentId: idFor('some-other-project'),
      updatedAtUtc: nowIso(),
      updatedTimezone: 'Asia/Shanghai',
    },
  },
})
check('进展的内容能改', logUpdated.body?.record?.content === '同步自测 · 进展改过内容', logUpdated.body?.record?.content)
check(
  '⚠️ parentId 不可变：payload 里换一个也不生效',
  logUpdated.body?.record?.parentId === parentProject,
  { got: logUpdated.body?.record?.parentId, want: parentProject },
)

// 「没记进度」和「记了 0%」是两回事 —— 清空必须靠**显式 null**，
// 因为 Worker 用「键在不在」判断，而不是「值是不是假」。
const logCleared = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log-clear'),
    recordId: logRecord,
    operation: 'update',
    expectedVersion: 2,
    payload: { progress: null, updatedAtUtc: nowIso() },
  },
})
check(
  'progress 传显式 null 才清空（「没记」≠「记了 0%」）',
  logCleared.body?.record?.progress === null,
  logCleared.body?.record?.progress,
)

// 非 log 带 parentId 必须被丢弃，否则会撞上 CHECK（type = 'log' or parent_id is null）。
// 这条也是「客户端与服务端字段裁决必须一致」的回归点。
const todoWithParent = idFor('log-todo')
const todoCreated = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log-todo'),
    recordId: todoWithParent,
    operation: 'create',
    expectedVersion: null,
    payload: {
      ...createPayload('同步自测 · 带 parentId 的待办'),
      type: 'todo',
      parentId: parentProject,
      progress: 77,
    },
  },
})
check('非 log 带 parentId → 落库为 null', todoCreated.body?.record?.parentId === null, todoCreated.body?.record?.parentId)
check('非 log 带 progress → 落库为 null', todoCreated.body?.record?.progress === null, todoCreated.body?.record?.progress)

// 空白串也要当「没有父级」：空串既不等于 null、又匹配不到任何大事 id，
// 会让那条进展在所有设备上「挂在一个不存在的大事下」—— 界面表现是凭空消失。
const logBlankParent = idFor('log-blank')
const blankParentRes = await call('/api/sync/mutate', {
  body: {
    mutationId: mutationFor('log-blank'),
    recordId: logBlankParent,
    operation: 'create',
    expectedVersion: null,
    payload: { ...createPayload('同步自测 · 空 parentId'), type: 'log', parentId: '   ' },
  },
})
check('parentId 是空白串 → 落库为 null', blankParentRes.body?.record?.parentId === null, blankParentRes.body?.record?.parentId)

// ---------------------------------------------------------------
section('6. 清理本次测试记录')

// 红线：不做物理删除，所以这里也只软删除。留下的是 Tombstone，
// 界面上看不见，也不会影响你已有的记录。
const leftovers = [raceRecord, logRecord, todoWithParent, logBlankParent, parentProject]
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
