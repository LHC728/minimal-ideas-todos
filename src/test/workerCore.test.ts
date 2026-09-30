// @vitest-environment node
/**
 * Cloudflare Worker 后端核心逻辑（worker/src/core.ts）。
 *
 * 这组测试跑在**真实 SQLite** 上（见 sqliteD1.ts），并且加载了
 * worker/schema.sql 的触发器 —— 所以它验证的不只是「我的 TypeScript 写得对」，
 * 还包括「数据库真的会拦住越界操作」。
 *
 * 重点盯住的是产品红线，而不是分支覆盖率：
 *   - 同一 mutationId 只生效一次（幂等）
 *   - 版本对不上时**宁可报冲突也不覆盖**（绝不静默覆盖别人的修改）
 *   - 创建时间永不改变
 *   - 删除只能是软删除
 *   - 跨账号不可读写
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyMutation,
  pullAll,
  readRecord,
  readUser,
  resolveUser,
  sha256Hex,
  toCloudRecord,
  type ApplyMutationInput,
  type RecordRow,
} from '../../worker/src/core'
import { createSqliteD1, seedUser, type SqliteD1 } from './sqliteD1'

const USER_A = 'user-a'
const USER_B = 'user-b'
const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** 固定时钟：测试不该依赖真实时间，否则跨零点跑就会偶发失败 */
const T0 = '2026-09-30T01:00:00.000Z'
const T1 = '2026-09-30T02:00:00.000Z'
const T2 = '2026-09-30T03:00:00.000Z'

let db: SqliteD1

beforeEach(async () => {
  db = createSqliteD1()
  await seedUser(db, { userId: USER_A, email: 'a@example.com', token: TOKEN_A })
  await seedUser(db, { userId: USER_B, email: null, token: TOKEN_B })
})

function input(overrides: Partial<ApplyMutationInput> = {}): ApplyMutationInput {
  return {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create',
    expectedVersion: null,
    payload: {
      type: 'idea',
      content: '想到的那一刻',
      createdAtUtc: T0,
      createdTimezone: 'Asia/Shanghai',
      createdLocalDate: '2026-09-30',
      updatedAtUtc: T0,
      updatedTimezone: 'Asia/Shanghai',
    },
    ...overrides,
  }
}

// =====================================================================
describe('鉴权', () => {
  it('正确令牌换出 userId', async () => {
    expect(await resolveUser(db, TOKEN_A)).toBe(USER_A)
    expect(await resolveUser(db, TOKEN_B)).toBe(USER_B)
  })

  it('未知令牌返回 null', async () => {
    expect(await resolveUser(db, 'token-nope')).toBeNull()
  })

  it('空令牌返回 null', async () => {
    expect(await resolveUser(db, '')).toBeNull()
  })

  it('已撤销的令牌立即失效', async () => {
    db.exec(
      `update access_tokens set revoked_at = '${T1}' where token_hash = '${await sha256Hex(TOKEN_A)}'`,
    )
    expect(await resolveUser(db, TOKEN_A)).toBeNull()
  })

  it('库里不存令牌明文 —— 只看得到 SHA-256', async () => {
    const rows = db.rows<{ token_hash: string }>('select token_hash from access_tokens')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.token_hash).not.toBe(TOKEN_A)
      expect(row.token_hash).not.toBe(TOKEN_B)
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    }
    // 明文确实没落进库
    expect(
      db.row('select 1 as x from access_tokens where token_hash in (?, ?)', TOKEN_A, TOKEN_B),
    ).toBeNull()
  })
})

describe('读', () => {
  it('readUser 返回账号信息，email 可为空', async () => {
    expect(await readUser(db, USER_A)).toEqual({ userId: USER_A, email: 'a@example.com' })
    expect(await readUser(db, USER_B)).toEqual({ userId: USER_B, email: null })
    expect(await readUser(db, 'user-none')).toBeNull()
  })

  it('未创建的记录读到 null', async () => {
    expect(await readRecord(db, USER_A, 'r-none')).toBeNull()
  })

  it('只能读到自己的记录', async () => {
    await applyMutation(db, USER_A, input(), T0)
    expect(await readRecord(db, USER_A, 'r-1')).not.toBeNull()
    // 同一条 id，换个账号就是看不见
    expect(await readRecord(db, USER_B, 'r-1')).toBeNull()
  })

  it('pullAll 只返回自己的记录', async () => {
    await applyMutation(db, USER_A, input(), T0)
    await applyMutation(
      db,
      USER_B,
      input({ mutationId: 'm-b', recordId: 'r-b', payload: { type: 'todo', content: 'B 的事' } }),
      T0,
    )

    const forA = await pullAll(db, USER_A)
    const forB = await pullAll(db, USER_B)
    expect(forA.map((row) => row.id)).toEqual(['r-1'])
    expect(forB.map((row) => row.id)).toEqual(['r-b'])
  })

  it('pullAll 带上软删除的 Tombstone —— 否则另一台设备永远不知道这条被删了', async () => {
    await applyMutation(db, USER_A, input(), T0)
    // 客户端删一条记录时，payload 里一定带 deletedAtUtc
    // （ConflictService.diffSnapshot 只在值变化时才放进补丁）
    await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-del',
        operation: 'delete',
        expectedVersion: 1,
        payload: { deletedAtUtc: T1 },
      }),
      T1,
    )

    const rows = await pullAll(db, USER_A)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deletedAtUtc).toBe(T1)
  })

  it('pullAll 按 server_updated_at 升序', async () => {
    await applyMutation(db, USER_A, input({ recordId: 'r-a' }), T2)
    await applyMutation(db, USER_A, input({ mutationId: 'm-2', recordId: 'r-b' }), T0)
    await applyMutation(db, USER_A, input({ mutationId: 'm-3', recordId: 'r-c' }), T1)

    const rows = await pullAll(db, USER_A)
    expect(rows.map((row) => row.id)).toEqual(['r-b', 'r-c', 'r-a'])
  })
})

describe('toCloudRecord 映射', () => {
  it('下划线转驼峰，updated_timezone 为空时补 UTC', () => {
    const row: RecordRow = {
      id: 'r-1',
      user_id: 'u-1',
      type: 'todo',
      content: '内容',
      created_at_utc: T0,
      created_timezone: 'Asia/Shanghai',
      created_local_date: '2026-09-30',
      updated_at_utc: T0,
      updated_timezone: null,
      completed_at_utc: null,
      completed_timezone: null,
      deleted_at_utc: null,
      version: 3,
      server_updated_at: T1,
    }
    expect(toCloudRecord(row)).toEqual({
      id: 'r-1',
      userId: 'u-1',
      type: 'todo',
      content: '内容',
      createdAtUtc: T0,
      createdTimezone: 'Asia/Shanghai',
      createdLocalDate: '2026-09-30',
      updatedAtUtc: T0,
      updatedTimezone: 'UTC',
      completedAtUtc: null,
      completedTimezone: null,
      deletedAtUtc: null,
      version: 3,
      serverUpdatedAt: T1,
    })
  })

  it('未知 type 一律归为 idea（客户端类型只有两种）', () => {
    const row = db.row<RecordRow>('select 1 as id') // 占位，仅借类型
    expect(row).not.toBeNull()
    expect(
      toCloudRecord({ ...(row as RecordRow), type: 'something-else', version: 1 }).type,
    ).toBe('idea')
  })
})

// =====================================================================
describe('applyMutation — create', () => {
  it('新建成功，版本从 1 开始', async () => {
    const result = await applyMutation(db, USER_A, input(), T0)
    expect(result.status).toBe('applied')
    expect(result.version).toBe(1)
    expect(result.record?.content).toBe('想到的那一刻')
    expect(result.record?.version).toBe(1)
  })

  it('创建时间用客户端传来的值，不被服务器时间覆盖', async () => {
    const result = await applyMutation(db, USER_A, input(), T2)
    expect(result.record?.createdAtUtc).toBe(T0)
    expect(result.record?.createdLocalDate).toBe('2026-09-30')
    expect(result.record?.createdTimezone).toBe('Asia/Shanghai')
    // 服务器时间只出现在 serverUpdatedAt
    expect(result.record?.serverUpdatedAt).toBe(T2)
  })

  it('同一个 mutationId 重放只生效一次', async () => {
    const first = await applyMutation(db, USER_A, input(), T0)
    const replay = await applyMutation(db, USER_A, input(), T1)

    expect(first.status).toBe('applied')
    expect(replay.status).toBe('already_applied')
    expect(replay.version).toBe(1)

    expect(db.rows('select id from records')).toHaveLength(1)
    // 服务器时间没有被重放刷新 —— 说明真的没再写一次
    expect(db.row<{ server_updated_at: string }>('select server_updated_at from records')?.server_updated_at).toBe(T0)
  })

  it('同一个 id 换一个 mutationId 再 create → 报版本冲突，绝不覆盖已有记录', async () => {
    await applyMutation(db, USER_A, input(), T0)
    const again = await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-other', payload: { content: '别人的内容' } }),
      T1,
    )

    expect(again.status).toBe('version_conflict')
    expect(again.version).toBe(1)
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('想到的那一刻')
  })

  it('create 缺字段时有安全默认值', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({ payload: {} }),
      T0,
    )
    expect(result.status).toBe('applied')
    expect(result.record?.type).toBe('idea')
    expect(result.record?.content).toBe('')
    expect(result.record?.createdAtUtc).toBe(T0)
    expect(result.record?.createdLocalDate).toBe('2026-09-30')
  })
})

describe('applyMutation — update', () => {
  beforeEach(async () => {
    await applyMutation(db, USER_A, input(), T0)
  })

  it('版本对上就写入，版本 +1', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-2',
        operation: 'update',
        expectedVersion: 1,
        payload: { content: '改过的内容', updatedAtUtc: T1, updatedTimezone: 'Asia/Shanghai' },
      }),
      T1,
    )

    expect(result.status).toBe('applied')
    expect(result.version).toBe(2)
    expect(result.record?.content).toBe('改过的内容')
    expect(result.record?.serverUpdatedAt).toBe(T1)
  })

  it('★ 版本对不上时报冲突，且内容一个字都不动 —— 宁可多存也不静默覆盖', async () => {
    const conflict = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-stale',
        operation: 'update',
        expectedVersion: 99,
        payload: { content: '我不该被写进去' },
      }),
      T1,
    )

    expect(conflict.status).toBe('version_conflict')
    expect(conflict.version).toBe(1)
    expect(conflict.record?.content).toBe('想到的那一刻')
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('想到的那一刻')
  })

  it('已存在的记录不给 expectedVersion 也报冲突（不许盲写）', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-blind', operation: 'update', expectedVersion: null, payload: { content: '盲写' } }),
      T1,
    )
    expect(result.status).toBe('version_conflict')
  })

  it('重放同一次 update 不再 +1', async () => {
    const params = input({
      mutationId: 'm-2',
      operation: 'update',
      expectedVersion: 1,
      payload: { content: '改过的内容' },
    })
    const first = await applyMutation(db, USER_A, params, T1)
    const replay = await applyMutation(db, USER_A, params, T2)

    expect(first.version).toBe(2)
    expect(replay.status).toBe('already_applied')
    expect(replay.version).toBe(2)
    expect(db.row<{ version: number }>('select version from records')?.version).toBe(2)
  })

  it('只更新传了的字段，没传的保持原样', async () => {
    await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-2',
        operation: 'update',
        expectedVersion: 1,
        payload: { content: '只改内容' },
      }),
      T1,
    )

    const row = db.row<{ content: string; updated_at_utc: string; created_at_utc: string }>(
      'select content, updated_at_utc, created_at_utc from records',
    )
    expect(row?.content).toBe('只改内容')
    // 没传 updatedAtUtc，就不该被服务器时间顶替
    expect(row?.updated_at_utc).toBe(T0)
    expect(row?.created_at_utc).toBe(T0)
  })

  it('★ payload 里塞创建时间也没用 —— 这三列根本不在 UPDATE 语句里', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-2',
        operation: 'update',
        expectedVersion: 1,
        payload: {
          content: '内容可以改',
          createdAtUtc: '2000-01-01T00:00:00.000Z',
          createdLocalDate: '2000-01-01',
          createdTimezone: 'UTC',
          type: 'todo',
        },
      }),
      T1,
    )

    expect(result.status).toBe('applied')
    expect(result.record?.content).toBe('内容可以改')
    expect(result.record?.createdAtUtc).toBe(T0)
    expect(result.record?.createdLocalDate).toBe('2026-09-30')
    expect(result.record?.createdTimezone).toBe('Asia/Shanghai')
    expect(result.record?.type).toBe('idea')
  })

  it('更新不存在的记录 → record_not_found', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-x', recordId: 'r-none', operation: 'update', expectedVersion: 1, payload: { content: 'x' } }),
      T1,
    )
    expect(result.status).toBe('record_not_found')
    expect(result.record).toBeNull()
  })

  it('不能改别的账号的记录', async () => {
    const result = await applyMutation(
      db,
      USER_B,
      input({ mutationId: 'm-steal', operation: 'update', expectedVersion: 1, payload: { content: '偷改' } }),
      T1,
    )
    expect(result.status).toBe('record_not_found')
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('想到的那一刻')
  })
})

describe('applyMutation — complete / uncomplete / delete / restore', () => {
  beforeEach(async () => {
    await applyMutation(db, USER_A, input({ payload: { type: 'todo', content: '要做的事' } }), T0)
  })

  it('complete 写入完成时间', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-done',
        operation: 'complete',
        expectedVersion: 1,
        payload: { completedAtUtc: T1, completedTimezone: 'Asia/Shanghai' },
      }),
      T1,
    )
    expect(result.status).toBe('applied')
    expect(result.record?.completedAtUtc).toBe(T1)
    expect(result.record?.completedTimezone).toBe('Asia/Shanghai')
    expect(result.version).toBe(2)
  })

  it('uncomplete 用显式 null 清空完成时间', async () => {
    await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-done',
        operation: 'complete',
        expectedVersion: 1,
        payload: { completedAtUtc: T1 },
      }),
      T1,
    )
    const undone = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-undone',
        operation: 'uncomplete',
        expectedVersion: 2,
        payload: { completedAtUtc: null, completedTimezone: null },
      }),
      T2,
    )

    expect(undone.status).toBe('applied')
    expect(undone.record?.completedAtUtc).toBeNull()
    expect(undone.record?.completedTimezone).toBeNull()
  })

  it('delete 是软删除 —— 记录还在库里，只是打了删除时间', async () => {
    const result = await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-del', operation: 'delete', expectedVersion: 1, payload: { deletedAtUtc: T1 } }),
      T1,
    )
    expect(result.status).toBe('applied')
    expect(result.record?.deletedAtUtc).toBe(T1)

    // 物理上还在
    expect(db.rows('select id from records')).toHaveLength(1)
  })

  it('restore 清掉删除时间 —— 这就是「后悔药」', async () => {
    await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-del', operation: 'delete', expectedVersion: 1, payload: { deletedAtUtc: T1 } }),
      T1,
    )
    const restored = await applyMutation(
      db,
      USER_A,
      input({ mutationId: 'm-restore', operation: 'restore', expectedVersion: 2, payload: { deletedAtUtc: null } }),
      T2,
    )
    expect(restored.status).toBe('applied')
    expect(restored.record?.deletedAtUtc).toBeNull()
  })
})

// =====================================================================
describe('数据库红线（触发器真的会拦住越界操作）', () => {
  beforeEach(async () => {
    await applyMutation(db, USER_A, input(), T0)
  })

  it('物理 DELETE 被拒绝', () => {
    expect(() => db.exec('delete from records')).toThrow(/records_must_be_soft_deleted/)
    expect(db.rows('select id from records')).toHaveLength(1)
  })

  it('改 created_at_utc 被拒绝', () => {
    // 同时把 version 也 +1，否则会先被 version 触发器拦下 ——
    // 那样测到的就不是「创建时间不可变」这条规则了。
    // （SQLite 对同一事件的多个触发器不保证触发顺序，所以这里必须把
    //  version 的干扰排除掉，才能确定是哪一个触发器拒绝的。）
    expect(() =>
      db.exec(
        `update records set created_at_utc = '${T1}', version = version + 1 where id = 'r-1'`,
      ),
    ).toThrow(/created_fields_are_immutable/)
  })

  it('改 created_local_date / created_timezone / id / user_id / type 都被拒绝', () => {
    for (const sql of [
      `update records set created_local_date = '2000-01-01', version = version + 1 where id = 'r-1'`,
      `update records set created_timezone = 'UTC', version = version + 1 where id = 'r-1'`,
      `update records set id = 'r-9', version = version + 1 where id = 'r-1'`,
      `update records set user_id = 'user-b', version = version + 1 where id = 'r-1'`,
      `update records set type = 'todo', version = version + 1 where id = 'r-1'`,
    ]) {
      expect(() => db.exec(sql)).toThrow(/created_fields_are_immutable/)
    }
  })

  it('不让 version 变大的 UPDATE 一律被拒绝 —— 杜绝「悄悄改了内容却没留痕」', () => {
    expect(() => db.exec(`update records set content = '偷偷改' where id = 'r-1'`)).toThrow(
      /version_must_increase/,
    )
    expect(() =>
      db.exec(`update records set content = '偷偷改', version = 0 where id = 'r-1'`),
    ).toThrow(/version_must_increase/)
  })

  it('已完成的幂等结果不可改写', () => {
    expect(() =>
      db.exec(`update applied_mutations set result_version = 99 where mutation_id = 'm-1'`),
    ).toThrow(/mutation_result_is_final/)
  })
})

describe('竞态：读完之后、写下去之前，别人插了一脚', () => {
  /**
   * 这一组是整个后端最关键的测试。
   *
   * 真正的风险不是「先后调用两次」（那种情况很好处理），
   * 而是两台设备同时操作：双方都读到了同样的版本，都以为可以写。
   * 这里用 onBeforeBatch 精确插到「已经读完、正要写」的那一刻，
   * 模拟另一台设备抢先一步 —— 如果写入不是由版本条件兜住的，
   * 就会覆盖掉对方的修改，而客户端还以为是成功。
   */
  it('★ create 期间别人先建了同一条 → 报冲突，且绝不冒充「已应用」', async () => {
    db.onBeforeBatch = () => {
      db.onBeforeBatch = null
      // 另一台设备抢先建好了同一条记录
      db.exec(
        `insert into records (id, user_id, type, content,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, version, server_updated_at)
         values ('r-1', '${USER_A}', 'idea', '对方写的',
           '${T0}', 'UTC', '2026-09-30', '${T0}', 1, '${T0}')`,
      )
    }

    const result = await applyMutation(db, USER_A, input(), T1)

    expect(result.status).toBe('version_conflict')
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('对方写的')
    // 关键：没有留下「其实没生效却被记成已应用」的幂等记录
    expect(db.row('select 1 as x from applied_mutations where mutation_id = ?', 'm-1')).toBeNull()
  })

  it('★ update 期间别人先改了同一条 → 报冲突，我的内容一个字都没写进去', async () => {
    await applyMutation(db, USER_A, input(), T0)

    db.onBeforeBatch = () => {
      db.onBeforeBatch = null
      // 另一台设备抢先提交了同一版本（expectedVersion = 1）的修改
      db.exec(
        `update records set content = '对方写的', version = 2, server_updated_at = '${T1}'
         where id = 'r-1'`,
      )
    }

    const result = await applyMutation(
      db,
      USER_A,
      input({
        mutationId: 'm-2',
        operation: 'update',
        expectedVersion: 1,
        payload: { content: '我这台写的' },
      }),
      T1,
    )

    expect(result.status).toBe('version_conflict')
    expect(result.version).toBe(2)
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('对方写的')
    expect(db.row('select 1 as x from applied_mutations where mutation_id = ?', 'm-2')).toBeNull()
  })

  it('两路同时提交（同一个 id 两个 mutationId）只会落一条，另一路拿不到「已应用」', async () => {
    const [first, second] = await Promise.all([
      applyMutation(db, USER_A, input({ mutationId: 'm-a' }), T0),
      applyMutation(db, USER_A, input({ mutationId: 'm-b' }), T0),
    ])

    expect([first.status, second.status].toSorted()).toEqual(['applied', 'version_conflict'])
    expect(db.rows('select id from records')).toHaveLength(1)
    // 只有真正写进去的那一路留下幂等记录
    expect(db.rows('select mutation_id from applied_mutations')).toHaveLength(1)
  })

  it('同一版本的两次 update 只有一次生效，另一次不留下「已应用」', async () => {
    await applyMutation(db, USER_A, input(), T0)

    const [first, second] = await Promise.all([
      applyMutation(
        db,
        USER_A,
        input({ mutationId: 'm-a', operation: 'update', expectedVersion: 1, payload: { content: 'A' } }),
        T1,
      ),
      applyMutation(
        db,
        USER_A,
        input({ mutationId: 'm-b', operation: 'update', expectedVersion: 1, payload: { content: 'B' } }),
        T1,
      ),
    ])

    const applied = [first, second].filter((result) => result.status === 'applied')
    expect(applied).toHaveLength(1)
    expect(db.row<{ version: number }>('select version from records')?.version).toBe(2)
    expect(db.rows('select mutation_id from applied_mutations where mutation_id like ?', 'm-%')).toHaveLength(
      2, // create 那次 + 这次生效的那次
    )
  })
})
