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
