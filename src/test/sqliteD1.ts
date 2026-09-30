/**
 * 测试用的 D1 替身 —— 但它**不是**「我说它对它就对」的假实现。
 *
 * 它把 core.ts 发出的 SQL 原样交给 Node 内置的真实 SQLite 执行
 * （node:sqlite，Node 22.5+ 起可用），并且连 worker/schema.sql 里的
 * 触发器一起加载。
 *
 * 为什么要这么绕：本项目的红线（创建时间不可变 / 只能软删除 /
 * version 单调递增 / 幂等结果不可改写）在 Cloudflare 这一侧**全部是
 * SQL 触发器实现的**。如果用一个手写的假 D1，那些触发器在测试里
 * 根本不会运行 —— 测了半天，恰好把最该守的底线漏掉。
 *
 * 用真实 SQLite 还有一个附带好处：SQLite 就是 D1 的引擎，
 * 所以 `on conflict do nothing`、`insert ... select ... where exists`、
 * `raise(abort, ...)` 这些语句的行为和线上是同一套语义。
 *
 * 已知差异（如实记录，不要假装没有）：
 *   1. D1 是多副本的分布式 SQLite，本替身是单连接 ——
 *      所以这里测不到「跨副本最终一致」这类问题，只测单次请求内的原子性。
 *   2. D1 的 batch 是真事务，本替身用 begin/commit 模拟，语义一致。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1Result, D1Statement } from '../../worker/src/core'

/** node:sqlite 接受的绑定值类型 */
type SqlValue = null | number | bigint | string | Uint8Array

/**
 * 把 Worker 传进来的绑定值收口成 SQLite 能接受的值。
 *
 * 这里刻意「宁可抛错也不静默转换」：`undefined` 在 SQLite 里会被当成 NULL，
 * 于是一个「忘了传值」的 bug 会伪装成「值就是空」—— 那正是最难查的一类问题。
 */
function toSqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (value === undefined) {
      throw new Error('D1 绑定值不允许 undefined（会被静默当成 NULL，掩盖真实缺陷），请显式传 null')
    }
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new Error(`D1 绑定值类型不受支持：${typeof value}`)
  })
}

export interface SqliteD1 extends D1Database {
  /** 直接执行 SQL（建表、模拟「有人绕过 Worker 直连数据库」） */
  exec(sql: string): void
  /** 直接查询多行，用于断言库里的真实状态 */
  rows<T>(sql: string, ...values: unknown[]): T[]
  /** 直接查询单行 */
  row<T>(sql: string, ...values: unknown[]): T | null
  /**
   * 在每次 batch 真正开始前插一段逻辑，用来复现「查完版本、还没写」之间
   * 被另一个写入者插队的竞态。用完记得置回 null。
   */
  onBeforeBatch: (() => void | Promise<void>) | null
  close(): void
}

/**
 * 建一个内存库并加载 schema。
 *
 * @param schemaFile 相对仓库根的 SQL 文件路径
 */
export function createSqliteD1(schemaFile = 'worker/schema.sql'): SqliteD1 {
  const db = new DatabaseSync(':memory:')
  db.exec('pragma foreign_keys = on')
  db.exec(readFileSync(resolve(process.cwd(), schemaFile), 'utf8'))

  const prepare = (query: string): D1Statement => {
    let bound: unknown[] = []
    const statement: D1Statement = {
      bind(...values: unknown[]): D1Statement {
        bound = values
        return statement
      },
      async first<T>(): Promise<T | null> {
        const result = db.prepare(query).get(...toSqlValues(bound))
        return (result ?? null) as T | null
      },
      async run(): Promise<D1Result> {
        const info = db.prepare(query).run(...toSqlValues(bound))
        return { results: [], success: true, meta: { changes: Number(info.changes) } }
      },
      async all<T>(): Promise<D1Result<T>> {
        const result = db.prepare(query).all(...toSqlValues(bound))
        return { results: result as T[], success: true, meta: {} }
      },
    }
    return statement
  }

  const hook: { onBeforeBatch: (() => void | Promise<void>) | null } = { onBeforeBatch: null }

  /**
   * 把一段异步工作串行执行：前一个没结束，后一个不开始。
   * 前一个失败不会卡住后一个 —— 「上一个事务回滚了」不该让后续操作永远拿不到锁。
   */
  let tail: Promise<void> = Promise.resolve()
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * 与 D1 的 batch 一致：整批要么全成功、要么全回滚。
   * core.ts 正是靠这个性质保证「记录写入」与「幂等记录写入」不会半截生效。
   *
   * 这里用一条 Promise 链把 batch 串行化 —— 不是偷懒，而是**如实模拟**：
   * SQLite 任意时刻只允许一个写入者，D1 也一样（它把并发请求排进同一个写队列）。
   * 如果不串行化，两个并发的 applyMutation 会同时在同一个连接上 BEGIN，
   * 得到的是 "cannot start a transaction within a transaction" 这种
   * 现实中不可能出现的错误，测试就变成了在测一个虚构的故障。
   */
  const batch = (statements: D1Statement[]): Promise<D1Result[]> =>
    serialize(async () => {
      await hook.onBeforeBatch?.()
      db.exec('begin')
      try {
        const results: D1Result[] = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('commit')
        return results
      } catch (error) {
        db.exec('rollback')
        throw error
      }
    })

  return {
    prepare,
    batch,
    get onBeforeBatch(): (() => void | Promise<void>) | null {
      return hook.onBeforeBatch
    },
    set onBeforeBatch(value: (() => void | Promise<void>) | null) {
      hook.onBeforeBatch = value
    },
    exec(sql: string): void {
      db.exec(sql)
    },
    rows<T>(sql: string, ...values: unknown[]): T[] {
      return db.prepare(sql).all(...toSqlValues(values)) as T[]
    },
    row<T>(sql: string, ...values: unknown[]): T | null {
      return (db.prepare(sql).get(...toSqlValues(values)) ?? null) as T | null
    },
    close(): void {
      db.close()
    },
  }
}

/**
 * 建一个账号并返回可用的明文令牌。
 * 库里只存 SHA-256 —— 这一点由 workerSchema 测试另外钉住。
 */
export async function seedUser(
  db: SqliteD1,
  options: { userId: string; email?: string | null; token: string; revoked?: boolean },
): Promise<void> {
  const { sha256Hex } = await import('../../worker/src/core')
  const hash = await sha256Hex(options.token)
  const now = new Date().toISOString()
  db.exec(
    `insert into users (id, email, created_at) values ('${options.userId}', ` +
      `${options.email === undefined || options.email === null ? 'null' : `'${options.email}'`}, '${now}')`,
  )
  db.exec(
    `insert into access_tokens (token_hash, user_id, label, created_at, revoked_at) values (` +
      `'${hash}', '${options.userId}', 'test', '${now}', ${options.revoked === true ? `'${now}'` : 'null'})`,
  )
}
