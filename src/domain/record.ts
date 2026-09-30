/**
 * 领域模型：整个 APP 只有一种核心数据 —— Record（方案 §5、§31）。
 *
 *   灵感 = Record(type = "idea")
 *   待办 = Record(type = "todo")
 *
 * 四个页面只是对同一份数据的不同观察方式。
 */

export type RecordType = 'idea' | 'todo'

/**
 * 本地同步元数据。属于本机状态，不作为业务数据在各端互相同步（方案 §31）。
 */
export type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'error'

export interface LocalRecord {
  /** UUID v4，客户端生成 */
  id: string
  userId: string

  type: RecordType
  content: string

  /** 第一次写下的那一刻，永不改变（§10） */
  createdAtUtc: string
  createdTimezone: string
  /** 归档日：日历按此字段归档（§12） */
  createdLocalDate: string

  /** 最后一次编辑 */
  updatedAtUtc: string
  updatedTimezone: string

  /** 完成时间，与删除完全独立（§20） */
  completedAtUtc: string | null
  completedTimezone: string | null

  /** 软删除时间。V1 永远不做物理删除（§15、§16） */
  deletedAtUtc: string | null

  /** 本地记录自己最后同步到的服务器版本 */
  serverVersion: number | null

  syncState: SyncState
}

/** 可同步的业务字段快照，用于三方合并与冲突展示（§36、§51） */
export interface RecordSnapshot {
  type: RecordType
  content: string
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
}

/**
 * 云端 Record（方案 §32）。放在 domain 层是为了让 db 与 cloud 都依赖它，
 * 而不产生 db → cloud 的反向依赖。
 */
export interface CloudRecord {
  id: string
  userId: string
  type: RecordType
  content: string
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
  /** 每次成功变化 +1，用于乐观并发控制（§38） */
  version: number
  /** 服务器同步时间，绝不覆盖用户记录时间（§11） */
  serverUpdatedAt: string
}

export function snapshotOf(record: LocalRecord): RecordSnapshot {
  return {
    type: record.type,
    content: record.content,
    createdAtUtc: record.createdAtUtc,
    createdTimezone: record.createdTimezone,
    createdLocalDate: record.createdLocalDate,
    updatedAtUtc: record.updatedAtUtc,
    updatedTimezone: record.updatedTimezone,
    completedAtUtc: record.completedAtUtc,
    completedTimezone: record.completedTimezone,
    deletedAtUtc: record.deletedAtUtc,
  }
}

export function snapshotOfCloud(cloud: CloudRecord): RecordSnapshot {
  return {
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
  }
}

export function snapshotOfSnapshotAndPatch(
  base: RecordSnapshot,
  patch: Partial<RecordSnapshot>,
): RecordSnapshot {
  return { ...base, ...patch }
}

export function emptySnapshot(): RecordSnapshot {
  return {
    type: 'idea',
    content: '',
    createdAtUtc: '',
    createdTimezone: 'UTC',
    createdLocalDate: '1970-01-01',
    updatedAtUtc: '',
    updatedTimezone: 'UTC',
    completedAtUtc: null,
    completedTimezone: null,
    deletedAtUtc: null,
  }
}

export function snapshotEquals(a: RecordSnapshot, b: RecordSnapshot): boolean {
  return (
    a.type === b.type &&
    a.content === b.content &&
    a.createdAtUtc === b.createdAtUtc &&
    a.createdTimezone === b.createdTimezone &&
    a.createdLocalDate === b.createdLocalDate &&
    a.completedAtUtc === b.completedAtUtc &&
    a.completedTimezone === b.completedTimezone &&
    a.deletedAtUtc === b.deletedAtUtc
  )
}

// ---------------------------------------------------------------
// 观察方式（四个页面的语义，§6、§78、§79）
// ---------------------------------------------------------------

/** 首页：idea + todo，按创建时间倒序，已完成仍保留（视觉变淡） */
export function isOnTimeline(record: LocalRecord): boolean {
  return record.deletedAtUtc === null
}

/** 灵感页 */
export function isIdea(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type === 'idea'
}

/** 待办页：只显示未完成的 todo */
export function isOpenTodo(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type === 'todo' && record.completedAtUtc === null
}

/** 已完成 todo */
export function isDoneTodo(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type === 'todo' && record.completedAtUtc !== null
}

/** 搜索：content 包含关键字，不含已删除（§61） */
export function matchesQuery(record: LocalRecord, query: string): boolean {
  if (record.deletedAtUtc !== null) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return record.content.toLowerCase().includes(q)
}

/** 创建时间倒序（新的在前） */
export function byCreatedAtDesc(a: LocalRecord, b: LocalRecord): number {
  const diff = new Date(b.createdAtUtc).getTime() - new Date(a.createdAtUtc).getTime()
  if (diff !== 0) return diff
  // 同一毫秒时用 id 兜底，保证顺序稳定
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * 完成时间倒序（刚完成的在前）。
 * 待办页「已完成」区用它 —— 刚手滑打勾的那条应该排在最上面，一眼就能撤销。
 */
export function byCompletedAtDesc(a: LocalRecord, b: LocalRecord): number {
  const at = a.completedAtUtc ? new Date(a.completedAtUtc).getTime() : 0
  const bt = b.completedAtUtc ? new Date(b.completedAtUtc).getTime() : 0
  if (bt !== at) return bt - at
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** 按 created_local_date 分组，日期倒序 */
export interface DateGrouped<T> {
  date: string
  items: T[]
}

export function groupByLocalDate<T extends LocalRecord>(records: T[]): DateGrouped<T>[] {
  const map = new Map<string, T[]>()
  for (const record of records) {
    const list = map.get(record.createdLocalDate)
    if (list) list.push(record)
    else map.set(record.createdLocalDate, [record])
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({ date, items: items.slice().sort(byCreatedAtDesc) }))
}
