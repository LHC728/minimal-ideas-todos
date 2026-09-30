/**
 * 一刻 — Cloudflare 同步后端的核心逻辑。
 *
 * 这里刻意与 HTTP 层分离：路由和 CORS 在 index.ts，本文件只关心
 * 「鉴权」和「原子应用一次 Mutation」这两件事，方便直接写单测。
 *
 * 语义必须与 supabase/migrations/0001_init.sql 里的 apply_record_mutation
 * 逐条对齐 —— 两套后端是可互换的，客户端的同步引擎不该感知到差别。
 */

// ---------------------------------------------------------------
// D1 的最小类型声明
//
// 故意不引 @cloudflare/workers-types：本项目的主 tsconfig 只带 DOM lib，
// 引它要多一套 tsconfig 和一个新依赖，而这里真正用到的只有 4 个方法。
// 需要完整 Workers 类型时再引也不迟。
// ---------------------------------------------------------------

export interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: { changes?: number }
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = unknown>(): Promise<T | null>
  run(): Promise<D1Result>
  all<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<D1Result[]>
}

export interface Env {
  DB: D1Database
  /** 逗号分隔的允许来源；不设则允许全部（令牌鉴权，无 Cookie，不涉及 CSRF） */
  ALLOWED_ORIGINS?: string
}

// ---------------------------------------------------------------
// 行 / 返回结构
// ---------------------------------------------------------------

export interface RecordRow {
  id: string
  user_id: string
  type: string
  content: string
  created_at_utc: string
  created_timezone: string
  created_local_date: string
  updated_at_utc: string
  updated_timezone: string | null
  completed_at_utc: string | null
  completed_timezone: string | null
  deleted_at_utc: string | null
  version: number
  server_updated_at: string
}

/** 与客户端 CloudRecord 一一对应（下划线转驼峰）。
 *  updatedTimezone 在客户端是必填 string，所以这里也补齐默认值，
 *  两边形状完全一致，客户端就不必再做一次防御性归一。 */
export interface CloudRecordOut {
  id: string
  userId: string
  type: 'idea' | 'todo'
  content: string
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
  version: number
  serverUpdatedAt: string
}

export function toCloudRecord(row: RecordRow): CloudRecordOut {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type === 'todo' ? 'todo' : 'idea',
    content: row.content,
    createdAtUtc: row.created_at_utc,
    createdTimezone: row.created_timezone,
    createdLocalDate: row.created_local_date,
    updatedAtUtc: row.updated_at_utc,
    updatedTimezone: row.updated_timezone ?? 'UTC',
    completedAtUtc: row.completed_at_utc,
    completedTimezone: row.completed_timezone,
    deletedAtUtc: row.deleted_at_utc,
    version: Number(row.version),
    serverUpdatedAt: row.server_updated_at,
  }
}

const RECORD_COLUMNS = [
  'id',
  'user_id',
  'type',
  'content',
  'created_at_utc',
  'created_timezone',
  'created_local_date',
  'updated_at_utc',
  'updated_timezone',
  'completed_at_utc',
  'completed_timezone',
  'deleted_at_utc',
  'version',
  'server_updated_at',
].join(', ')

// ---------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * 令牌 → userId。
 * 库里只存 SHA-256，所以即使数据库被看到也无法反推出可用的令牌。
 */
export async function resolveUser(db: D1Database, token: string): Promise<string | null> {
  if (token === '') return null
  const hash = await sha256Hex(token)
  const row = await db
    .prepare('select user_id, revoked_at from access_tokens where token_hash = ?')
    .bind(hash)
    .first<{ user_id: string; revoked_at: string | null }>()
  if (!row) return null
  if (row.revoked_at !== null) return null
  return row.user_id
}

// ---------------------------------------------------------------
// 读
// ---------------------------------------------------------------

export interface UserInfo {
  userId: string
  email: string | null
}

/**
 * 令牌对应的账号信息。
 *
 * 客户端必须知道自己的 userId —— 本机已有的记录要在首次登录时
 * 归到这个账号下（§81），userId 搞错了记录就会挂到别人名下。
 */
export async function readUser(db: D1Database, userId: string): Promise<UserInfo | null> {
  const row = await db
    .prepare('select id, email from users where id = ?')
    .bind(userId)
    .first<{ id: string; email: string | null }>()
  if (!row) return null
  return { userId: row.id, email: row.email }
}

export async function readRecord(
  db: D1Database,
  userId: string,
  recordId: string,
): Promise<CloudRecordOut | null> {
  const row = await db
    .prepare(`select ${RECORD_COLUMNS} from records where id = ? and user_id = ?`)
    .bind(recordId, userId)
    .first<RecordRow>()
  return row ? toCloudRecord(row) : null
}

/**
 * 拉取该用户全部 Record（含软删除的 Tombstone）。
 * 数据量是「一个人的记录」，所以不做分页；上限只是个防呆。
 */
export async function pullAll(db: D1Database, userId: string): Promise<CloudRecordOut[]> {
  const result = await db
    .prepare(
      `select ${RECORD_COLUMNS} from records where user_id = ? order by server_updated_at asc limit 50000`,
    )
    .bind(userId)
    .all<RecordRow>()
  return (result.results ?? []).map(toCloudRecord)
}

// ---------------------------------------------------------------
// 写：原子应用一次 Mutation
// ---------------------------------------------------------------

export type MutationOperation =
  | 'create'
  | 'update'
  | 'complete'
  | 'uncomplete'
  | 'delete'
  | 'restore'

export type ApplyMutationStatus =
  | 'applied'
  | 'already_applied'
  | 'version_conflict'
  | 'record_not_found'

export interface ApplyMutationInput {
  mutationId: string
  recordId: string
  operation: MutationOperation
  expectedVersion: number | null
  payload: Record<string, unknown>
}

export interface ApplyMutationOutput {
  status: ApplyMutationStatus
  version: number | null
  record: CloudRecordOut | null
}

function has(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key)
}

/** 取字符串值；缺失、null、非字符串一律当作「没有值」 */
function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 与 Supabase 版 `coalesce(payload->>'content', content)` 等价 */
function strOr(payload: Record<string, unknown>, key: string, fallback: string): string {
  return str(payload, key) ?? fallback
}

/** 只有「键存在」才算要改 —— 显式传 null 表示清空（取消完成 / 取消删除） */
function present(payload: Record<string, unknown>, key: string): string | null {
  return str(payload, key)
}

export async function applyMutation(
  db: D1Database,
  userId: string,
  input: ApplyMutationInput,
  now: string,
): Promise<ApplyMutationOutput> {
  const { mutationId, recordId, operation, expectedVersion, payload } = input

  // ---------- 1. 幂等：同一个 mutationId 只允许生效一次 ----------
  const applied = await db
    .prepare('select result_version from applied_mutations where mutation_id = ? and user_id = ?')
    .bind(mutationId, userId)
    .first<{ result_version: number }>()

  if (applied && Number(applied.result_version) > 0) {
    return {
      status: 'already_applied',
      version: Number(applied.result_version),
      record: await readRecord(db, userId, recordId),
    }
  }

  // ---------- 2. 当前状态 ----------
  const current = await readRecord(db, userId, recordId)

  // ---------- 3. 不存在 ----------
  if (current === null) {
    if (operation !== 'create') {
      return { status: 'record_not_found', version: null, record: null }
    }

    const insertRecord = db
      .prepare(
        `insert into records (
           id, user_id, type, content,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, updated_timezone,
           completed_at_utc, completed_timezone, deleted_at_utc,
           version, server_updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         on conflict (id) do nothing`,
      )
      .bind(
        recordId,
        userId,
        strOr(payload, 'type', 'idea') === 'todo' ? 'todo' : 'idea',
        strOr(payload, 'content', ''),
        str(payload, 'createdAtUtc') ?? now,
        str(payload, 'createdTimezone') ?? 'UTC',
        str(payload, 'createdLocalDate') ?? now.slice(0, 10),
        str(payload, 'updatedAtUtc') ?? now,
        present(payload, 'updatedTimezone'),
        present(payload, 'completedAtUtc'),
        present(payload, 'completedTimezone'),
        present(payload, 'deletedAtUtc'),
        now,
      )

    // 幂等记录只在「这一条 INSERT 确实写进去了」时才写。
    //
    // 为什么用 changes() 而不是 `where exists (select 1 from records ...)`：
    // 后者会误判。设想两台设备同时新建了同一条记录（同一个 id、两个 mutationId）：
    // 先到的那条把行写进去了，后到的那条 INSERT 被 `on conflict do nothing`
    // 悄悄跳过 —— 但 exists 依然为真，于是后到的那条也会被记成「已应用」，
    // 而它带的（更新的）内容被丢掉了。客户端以为推送成功，之后 Pull 回来
    // 覆盖本地 —— 这就是**静默丢数据**，正是本项目最不能接受的事。
    //
    // changes() 返回上一条 INSERT/UPDATE/DELETE 实际改动的行数，
    // 在同一个 batch（同一连接、同一事务）里就是这条 INSERT 的真实结果：
    // 写进去了是 1，被冲突跳过是 0。判据从此和事实一致。
    const claimCreate = db
      .prepare(
        `insert into applied_mutations (mutation_id, user_id, record_id, result_version, applied_at)
         select ?, ?, ?, 1, ?
         where changes() = 1`,
      )
      .bind(mutationId, userId, recordId, now)

    await db.batch([insertRecord, claimCreate])
  } else {
    // ---------- 4. 已存在 ----------
    // 乐观并发：期望版本对不上就交给客户端做三方比较（§36）
    if (expectedVersion === null || expectedVersion !== current.version) {
      return { status: 'version_conflict', version: current.version, record: current }
    }

    const setContent = str(payload, 'content') !== null
    const setUpdatedAt = str(payload, 'updatedAtUtc') !== null
    const setUpdatedTz = str(payload, 'updatedTimezone') !== null
    const setCompletedAt = has(payload, 'completedAtUtc')
    const setCompletedTz = has(payload, 'completedTimezone')
    const setDeletedAt = has(payload, 'deletedAtUtc')

    const nextVersion = expectedVersion + 1

    // version = version + 1 写在 SET 里，WHERE 里再钉一次 version = ?，
    // 于是「检查版本」与「写入」是同一条语句 —— 不存在先查后写的竞态。
    const updateRecord = db
      .prepare(
        `update records set
           content            = case when ? = 1 then ? else content end,
           updated_at_utc     = case when ? = 1 then ? else updated_at_utc end,
           updated_timezone   = case when ? = 1 then ? else updated_timezone end,
           completed_at_utc   = case when ? = 1 then ? else completed_at_utc end,
           completed_timezone = case when ? = 1 then ? else completed_timezone end,
           deleted_at_utc     = case when ? = 1 then ? else deleted_at_utc end,
           version            = version + 1,
           server_updated_at  = ?
         where id = ? and user_id = ? and version = ?`,
      )
      .bind(
        setContent ? 1 : 0,
        str(payload, 'content'),
        setUpdatedAt ? 1 : 0,
        str(payload, 'updatedAtUtc'),
        setUpdatedTz ? 1 : 0,
        str(payload, 'updatedTimezone'),
        setCompletedAt ? 1 : 0,
        present(payload, 'completedAtUtc'),
        setCompletedTz ? 1 : 0,
        present(payload, 'completedTimezone'),
        setDeletedAt ? 1 : 0,
        present(payload, 'deletedAtUtc'),
        now,
        recordId,
        userId,
        expectedVersion,
      )

    // 与 create 同理：changes() 是「这条 UPDATE 到底改了几行」的真实答案。
    // 用 `where exists(... version = nextVersion)` 会误判 —— 并发的另一次
    // update 也可能把版本推到同一个 nextVersion，于是没写成功的这次
    // 会被记成「已应用」。
    const claimUpdate = db
      .prepare(
        `insert into applied_mutations (mutation_id, user_id, record_id, result_version, applied_at)
         select ?, ?, ?, ?, ?
         where changes() = 1`,
      )
      .bind(mutationId, userId, recordId, nextVersion, now)

    await db.batch([updateRecord, claimUpdate])
  }

  // ---------- 5. 以「幂等记录是否落库」为准判定结果 ----------
  // 两条语句在同一个 batch 里，batch 是事务，所以不会出现半截状态。
  const after = await db
    .prepare('select result_version from applied_mutations where mutation_id = ? and user_id = ?')
    .bind(mutationId, userId)
    .first<{ result_version: number }>()

  const finalRecord = await readRecord(db, userId, recordId)

  if (after && Number(after.result_version) > 0) {
    return { status: 'applied', version: Number(after.result_version), record: finalRecord }
  }

  // 没写进去 → 条件更新没命中 → 版本已被别人改过
  return {
    status: 'version_conflict',
    version: finalRecord?.version ?? null,
    record: finalRecord,
  }
}
