/**
 * IndexedDB（Dexie）—— Local First 的唯一真相来源（方案 §29）。
 *
 * UI 永远先读这里，服务器只是后台同步目标。
 */
import Dexie, { type Table } from 'dexie'
import type { LocalRecord, RecordSnapshot } from '../domain/record'
import type { Mutation } from '../domain/mutation'

export type ConflictKind = 'field' | 'delete-edit'

/** 冲突现场：Base / Local / Remote 三份都必须保留（§51） */
export interface ConflictEntry {
  recordId: string
  userId: string
  kind: ConflictKind
  /** 真正冲突的字段名 */
  fields: string[]
  base: RecordSnapshot
  local: RecordSnapshot
  remote: RecordSnapshot
  remoteVersion: number
  createdAt: string
}

export interface MetaEntry {
  key: string
  value: unknown
}

/**
 * IndexedDB 数据库名。
 *
 * ⚠️ 不要因为改产品名而改这个字符串 —— 它是**存储键**，不是显示名。
 * 一旦改动，浏览器会认为这是一个全新的空库，用户已有的全部记录都会「消失」
 * （数据其实还在磁盘上，但对 APP 不可见）。产品名请改 index.html / manifest。
 */
export const DB_NAME = 'inspiration-todo'

export class AppDatabase extends Dexie {
  records!: Table<LocalRecord, string>
  outbox!: Table<Mutation, string>
  conflicts!: Table<ConflictEntry, string>
  meta!: Table<MetaEntry, string>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(1).stores({
      records:
        'id, userId, type, createdAtUtc, createdLocalDate, deletedAtUtc, syncState, ' +
        '[userId+type], [userId+createdLocalDate], [userId+deletedAtUtc]',
      outbox:
        'mutationId, recordId, userId, state, createdAt, ' +
        '[recordId+state], [userId+state], [state+createdAt]',
      conflicts: 'recordId, userId, kind, createdAt',
      meta: 'key',
    })

    // ---- v2：大事（project）新增 progress / deadlineLocalDate ----
    //
    // 索引没有变化，但**必须**有这一次升级，不能只改类型了事。
    // 老记录里这两个键是 `undefined`，而云端返回的是 `null` ——
    // `snapshotEquals` 用的是严格相等，undefined ≠ null，
    // 于是「另一台设备根本没动过这条记录」会被判成「动过」，
    // 在删除冲突里凭空多出一个要用户裁决的弹窗。
    // 一次性把老数据补齐成 null，之后所有比较就都是同一套语义了。
    this.version(2)
      .stores({
        records:
          'id, userId, type, createdAtUtc, createdLocalDate, deletedAtUtc, syncState, ' +
          '[userId+type], [userId+createdLocalDate], [userId+deletedAtUtc]',
        outbox:
          'mutationId, recordId, userId, state, createdAt, ' +
          '[recordId+state], [userId+state], [state+createdAt]',
        conflicts: 'recordId, userId, kind, createdAt',
        meta: 'key',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('records')
          .toCollection()
          .modify((record: LocalRecord) => {
            // 这里刻意绕开类型系统：类型上 progress 是必填的 `number | null`，
            // 但磁盘上的老数据确实没有这个键。用索引签名视图才能如实地
            // 检查「键是否存在」，而不是被类型断言骗过去。
            const raw = record as unknown as Record<string, unknown>
            if (raw['progress'] === undefined) raw['progress'] = null
            if (raw['deadlineLocalDate'] === undefined) raw['deadlineLocalDate'] = null
          })
      })

    // ---- v3：进展记录（log）新增 parentId ----
    //
    // 与 v2 同一个理由：老记录里没有 `parentId` 这个键（`undefined`），
    // 而云端返回的是 `null`。`snapshotEquals` 用严格相等，`undefined ≠ null`
    // 会让「另一台设备没动过这条记录」被判成「动过」，凭空造出一个
    // 要用户裁决的删除冲突弹窗。一次性补齐成 null，之后语义就统一了。
    //
    // 索引刻意不变：进展的查询走「取该用户全部记录再在内存里过滤」，
    // 数据量是「一个人的记录」，加索引只会多一处要维护的东西。
    this.version(3)
      .stores({
        records:
          'id, userId, type, createdAtUtc, createdLocalDate, deletedAtUtc, syncState, ' +
          '[userId+type], [userId+createdLocalDate], [userId+deletedAtUtc]',
        outbox:
          'mutationId, recordId, userId, state, createdAt, ' +
          '[recordId+state], [userId+state], [state+createdAt]',
        conflicts: 'recordId, userId, kind, createdAt',
        meta: 'key',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('records')
          .toCollection()
          .modify((record: LocalRecord) => {
            const raw = record as unknown as Record<string, unknown>
            if (raw['parentId'] === undefined) raw['parentId'] = null
          })
      })
  }
}

/**
 * 当前生效的数据库实例。
 *
 * 用 `export let` 是为了让测试可以切换到「另一台设备」的独立 IndexedDB；
 * ES module 的实时绑定保证各仓库里 `db.records` 始终指向当前实例。
 */
export let db: AppDatabase = new AppDatabase()

/** 切换数据库实例（测试模拟多设备时使用） */
export function setActiveDatabase(next: AppDatabase): void {
  db = next
}

/** 测试与「清空本机数据」使用 */
export async function resetDatabase(): Promise<void> {
  await db.delete()
  await db.open()
}
