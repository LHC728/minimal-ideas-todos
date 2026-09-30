/**
 * Record 仓库 —— 本地唯一写入口（方案 §29、§34、§43）。
 *
 * 规则：
 *  1. UI 只调用这里，绝不直接碰 Supabase。
 *  2. 每次变化 = 写 Record + 写 Outbox Mutation，同一个 IndexedDB transaction。
 *  3. created_at 一旦写入永不改变（§10）。
 *  4. 完成 ≠ 删除（§20）；删除永远是 Soft Delete（§15）。
 */
import { db } from './db'
import { enqueueMutation } from './outboxRepository'
import type {
  CloudRecord,
  LocalRecord,
  RecordSnapshot,
  RecordType,
  SyncState,
} from '../domain/record'
import { snapshotOf } from '../domain/record'
import type { Mutation, MutationOperation, MutationPayload } from '../domain/mutation'
import { uuidv4 } from '../utils/id'
import { captureNow } from '../utils/timezone'

/** 未连接云端时使用的本机账号 ID */
export const LOCAL_USER_ID = 'local-device'

export interface CreateRecordInput {
  userId: string
  type: RecordType
  content: string
  /** 用于测试注入；默认取当前时刻 */
  nowUtc?: string
  timezone?: string | null
}

interface CommitContext {
  utc: string
  timezone: string
}

// ---------------------------------------------------------------
// 创建
// ---------------------------------------------------------------

export async function createRecord(input: CreateRecordInput): Promise<LocalRecord> {
  const captured = captureNow(input.nowUtc, input.timezone)
  const content = input.content.trim()

  const record: LocalRecord = {
    id: uuidv4(),
    userId: input.userId,
    type: input.type,
    content,
    createdAtUtc: captured.utc,
    createdTimezone: captured.timezone,
    createdLocalDate: captured.localDate,
    updatedAtUtc: captured.utc,
    updatedTimezone: captured.timezone,
    completedAtUtc: null,
    completedTimezone: null,
    deletedAtUtc: null,
    serverVersion: null,
    syncState: 'pending',
  }

  const mutation: Mutation = {
    mutationId: uuidv4(),
    userId: record.userId,
    recordId: record.id,
    operation: 'create',
    baseServerVersion: null,
    baseSnapshot: { ...snapshotOf(record), content: '' },
    payload: {
      type: record.type,
      content: record.content,
      createdAtUtc: record.createdAtUtc,
      createdTimezone: record.createdTimezone,
      createdLocalDate: record.createdLocalDate,
      updatedAtUtc: record.updatedAtUtc,
      updatedTimezone: record.updatedTimezone,
      completedAtUtc: null,
      completedTimezone: null,
      deletedAtUtc: null,
    },
    createdAt: captured.utc,
    retryCount: 0,
    state: 'pending',
  }

  await db.transaction('rw', db.records, db.outbox, async () => {
    await db.records.put(record)
    await enqueueMutation(mutation)
  })

  return record
}

// ---------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------

/** 编辑正文。created_at 不动，只更新 updated_at（§13）。 */
export async function updateContent(
  recordId: string,
  content: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  const next = content.trim()
  return commitChange(recordId, 'update', nowUtc, timezone, (record, ctx) => {
    if (record.content === next) return null
    record.content = next
    record.updatedAtUtc = ctx.utc
    record.updatedTimezone = ctx.timezone
    return { content: next, updatedAtUtc: ctx.utc, updatedTimezone: ctx.timezone }
  })
}

// ---------------------------------------------------------------
// 完成 / 取消完成（§19、§21）
// ---------------------------------------------------------------

export async function completeTodo(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'complete', nowUtc, timezone, (record, ctx) => {
    if (record.type !== 'todo' || record.completedAtUtc !== null || record.deletedAtUtc !== null) {
      return null
    }
    record.completedAtUtc = ctx.utc
    record.completedTimezone = ctx.timezone
    return { completedAtUtc: ctx.utc, completedTimezone: ctx.timezone }
  })
}

export async function uncompleteTodo(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'uncomplete', nowUtc, timezone, (record) => {
    if (record.completedAtUtc === null) return null
    record.completedAtUtc = null
    record.completedTimezone = null
    return { completedAtUtc: null, completedTimezone: null }
  })
}

// ---------------------------------------------------------------
// 软删除 / 恢复（§15、§59、§60）
// ---------------------------------------------------------------

export async function softDelete(recordId: string, nowUtc?: string): Promise<LocalRecord | null> {
  return commitChange(recordId, 'delete', nowUtc, undefined, (record, ctx) => {
    if (record.deletedAtUtc !== null) return null
    record.deletedAtUtc = ctx.utc
    return { deletedAtUtc: ctx.utc }
  })
}

export async function restoreRecord(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'restore', nowUtc, timezone, (record) => {
    if (record.deletedAtUtc === null) return null
    record.deletedAtUtc = null
    return { deletedAtUtc: null }
  })
}

// ---------------------------------------------------------------
// 内部：统一的“改 + 入队”事务
// ---------------------------------------------------------------

type ChangeBuilder = (
  record: LocalRecord,
  ctx: CommitContext,
) => MutationPayload | null

async function commitChange(
  recordId: string,
  operation: MutationOperation,
  nowUtc: string | undefined,
  timezone: string | null | undefined,
  build: ChangeBuilder,
): Promise<LocalRecord | null> {
  let result: LocalRecord | null = null

  await db.transaction('rw', db.records, db.outbox, async () => {
    const record = await db.records.get(recordId)
    if (!record) return

    const captured = captureNow(nowUtc, timezone ?? record.updatedTimezone)
    const baseSnapshot = snapshotOf(record)

    const patch = build(record, captured)
    if (patch === null) {
      result = record
      return
    }

    record.syncState = 'pending'
    await db.records.put(record)

    await enqueueMutation({
      mutationId: uuidv4(),
      userId: record.userId,
      recordId: record.id,
      operation,
      baseServerVersion: record.serverVersion,
      baseSnapshot,
      payload: patch,
      createdAt: captured.utc,
      retryCount: 0,
      state: 'pending',
    })

    result = record
  })

  return result
}

// ---------------------------------------------------------------
// 来自服务器的写入
// ---------------------------------------------------------------

function fromCloud(cloud: CloudRecord, syncState: SyncState): LocalRecord {
  return {
    id: cloud.id,
    userId: cloud.userId,
    type: cloud.type,
    content: cloud.content,
    createdAtUtc: cloud.createdAtUtc,
    createdTimezone: cloud.createdTimezone,
    createdLocalDate: cloud.createdLocalDate,
    updatedAtUtc: cloud.updatedAtUtc,
    updatedTimezone: cloud.updatedTimezone,
    completedAtUtc: cloud.completedAtUtc,
    completedTimezone: cloud.completedTimezone,
    deletedAtUtc: cloud.deletedAtUtc,
    serverVersion: cloud.version,
    syncState,
  }
}

/**
 * 采用服务器版本。
 *
 * - 本机已无待发送改动且没有未决冲突 → 完整采用服务器业务字段（含软删除 Tombstone，防复活）
 * - 本机仍有改动或冲突 → 只更新 serverVersion，业务字段留给 Reconcile / 用户决定
 */
export async function applyCloudRecord(cloud: CloudRecord): Promise<void> {
  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    const local = await db.records.get(cloud.id)
    if (!local) {
      await db.records.put(fromCloud(cloud, 'synced'))
      return
    }

    const pending = await db.outbox.where('[recordId+state]').equals([cloud.id, 'pending']).count()
    const sending = await db.outbox.where('[recordId+state]').equals([cloud.id, 'sending']).count()
    const conflict = await db.conflicts.get(cloud.id)

    if (pending + sending === 0 && !conflict) {
      await db.records.put(fromCloud(cloud, 'synced'))
    } else {
      await db.records.put({ ...local, serverVersion: cloud.version })
    }
  })
}

/** 只更新本机记录的 serverVersion（Push 成功后） */
export async function setServerVersion(recordId: string, version: number): Promise<void> {
  await db.records.where('id').equals(recordId).modify((record) => {
    record.serverVersion = version
  })
}

/** 把本地记录整体替换为某个快照（安全合并 / 冲突裁决使用） */
export async function replaceWithSnapshot(
  recordId: string,
  snapshot: RecordSnapshot,
  syncState: SyncState,
  serverVersion?: number | null,
): Promise<void> {
  await db.records.where('id').equals(recordId).modify((record) => {
    record.type = snapshot.type
    record.content = snapshot.content
    record.createdAtUtc = snapshot.createdAtUtc
    record.createdTimezone = snapshot.createdTimezone
    record.createdLocalDate = snapshot.createdLocalDate
    record.updatedAtUtc = snapshot.updatedAtUtc
    record.updatedTimezone = snapshot.updatedTimezone
    record.completedAtUtc = snapshot.completedAtUtc
    record.completedTimezone = snapshot.completedTimezone
    record.deletedAtUtc = snapshot.deletedAtUtc
    record.syncState = syncState
    if (serverVersion !== undefined) record.serverVersion = serverVersion
  })
}

// ---------------------------------------------------------------
// 查询（UI 通过 useLiveQuery 直接读表，这里提供少量辅助）
// ---------------------------------------------------------------

export async function getRecord(recordId: string): Promise<LocalRecord | undefined> {
  return db.records.get(recordId)
}

export async function countRecords(userId: string): Promise<number> {
  return db.records.where('userId').equals(userId).count()
}

// ---------------------------------------------------------------
// 本机模式 → 账号迁移（保证“数据不丢”优先级最高，§81）
// ---------------------------------------------------------------

/**
 * 把本机（未登录）创建的记录归入某个账号。
 * 这些记录从未上过服务器，因此重置 serverVersion 并改用 create Mutation。
 */
export async function migrateLocalRecordsToUser(targetUserId: string): Promise<number> {
  let migrated = 0

  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    const locals = await db.records.where('userId').equals(LOCAL_USER_ID).toArray()
    if (locals.length === 0) return

    for (const record of locals) {
      await db.outbox.where('recordId').equals(record.id).delete()
      await db.conflicts.delete(record.id)

      const next: LocalRecord = { ...record, userId: targetUserId, serverVersion: null, syncState: 'pending' }
      await db.records.put(next)

      await db.outbox.put({
        mutationId: uuidv4(),
        userId: targetUserId,
        recordId: record.id,
        operation: 'create',
        baseServerVersion: null,
        baseSnapshot: { ...snapshotOf(next), content: '' },
        payload: {
          type: next.type,
          content: next.content,
          createdAtUtc: next.createdAtUtc,
          createdTimezone: next.createdTimezone,
          createdLocalDate: next.createdLocalDate,
          updatedAtUtc: next.updatedAtUtc,
          updatedTimezone: next.updatedTimezone,
          completedAtUtc: next.completedAtUtc,
          completedTimezone: next.completedTimezone,
          deletedAtUtc: next.deletedAtUtc,
        },
        createdAt: next.createdAtUtc,
        retryCount: 0,
        state: 'pending',
      })
      migrated += 1
    }
  })

  return migrated
}
