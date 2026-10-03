/**
 * 领域模型：整个 APP 只有一种核心数据 —— Record（方案 §5、§31）。
 *
 *   灵感 = Record(type = "idea")
 *   待办 = Record(type = "todo")
 *   大事 = Record(type = "project")   —— 带进度与截止日
 *   进展 = Record(type = "log")       —— 挂在某件大事下（parentId 指向它）
 *
 * 四个页面只是对同一份数据的不同观察方式。
 *
 * 「大事」与「进展」都刻意**不新建表**：它们必须走同一条同步 / 冲突 / 撤销链路，
 * 否则每加一种记录类型就要再写一遍 Outbox、三方合并和幂等 —— 五份代码、
 * 五个新的丢数据点。代价只是 idea / todo 上多几个恒为 null 的字段。
 *
 * ⚠️ 进展（log）是**子记录**，不是第五个一级入口：
 *   它只在大事详情里出现，**永远不进首页时间线 / 日历 / 搜索**。
 *   这条约束由本文件底部的过滤器统一保证 —— 加新类型时最容易漏的就是这里，
 *   漏了的表现是「进展刷屏首页」，而且不报任何错。
 */
import { parseLocalDate } from '../utils/time'

export type RecordType = 'idea' | 'todo' | 'project' | 'log'

/** 大事进度的取值范围与步进 */
export const PROGRESS_MIN = 0
export const PROGRESS_MAX = 100
export const PROGRESS_STEP = 5

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

  /**
   * 大事的推进进度，0–100 的整数。
   * idea / todo 恒为 null —— 只有大事才有「做到哪了」这回事。
   */
  progress: number | null

  /**
   * 大事的截止日，纯日期 `YYYY-MM-DD`（**不是时刻**）。
   *
   * 存纯日期是刻意的：用户想的是「几号之前」，不是「几点几分」；
   * 而且纯日期不带时区，换台设备看不会从 10月5日 漂成 10月4日。
   * 倒计时按本地日历日算差值，全程不碰时区换算。
   */
  deadlineLocalDate: string | null

  /**
   * 所属大事的 id。只有 `type === 'log'` 才有值，其余类型恒为 null。
   *
   * 进展的语义就是「这件事的第 N 条记录」，脱离父级没有意义，
   * 所以它是个必填的关系（在数据库层用 CHECK 钉住：非 log 不许带 parentId）。
   */
  parentId: string | null

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
  progress: number | null
  deadlineLocalDate: string | null
  parentId: string | null
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
  progress: number | null
  deadlineLocalDate: string | null
  parentId: string | null
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
    progress: record.progress,
    deadlineLocalDate: record.deadlineLocalDate,
    parentId: record.parentId,
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
    progress: cloud.progress,
    deadlineLocalDate: cloud.deadlineLocalDate,
    parentId: cloud.parentId,
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
    progress: null,
    deadlineLocalDate: null,
    parentId: null,
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
    a.progress === b.progress &&
    a.deadlineLocalDate === b.deadlineLocalDate &&
    a.parentId === b.parentId &&
    a.createdAtUtc === b.createdAtUtc &&
    a.createdTimezone === b.createdTimezone &&
    a.createdLocalDate === b.createdLocalDate &&
    a.completedAtUtc === b.completedAtUtc &&
    a.completedTimezone === b.completedTimezone &&
    a.deletedAtUtc === b.deletedAtUtc
  )
}

/**
 * 把任意来源的进度值收敛到 0–100 的整数。
 *
 * 进度会从云端流进来（远端可能是一个损坏的值），也会从滑块流进来
 * （滑块给的是字符串）。所以统一在这里收敛，绝不让 `undefined` /
 * `NaN` / `140` 这种东西进到领域模型里 —— 否则进度条会渲染出
 * `width: NaN%` 这种既看不见又查不出的东西。
 */
export function clampProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, Math.round(num)))
}

/** 大事的进度，缺失时按 0 处理 */
export function progressOf(record: LocalRecord): number {
  return record.progress ?? PROGRESS_MIN
}

/**
 * 收敛记录类型：只认四种，其余一律当作灵感。
 *
 * 两套后端的适配器都从这里取 —— 抄两份的话，将来加第四种类型时
 * 必然只改一处，另一处会把新类型悄悄降级成灵感。
 */
export function clampRecordType(value: unknown): RecordType {
  if (value === 'todo' || value === 'project' || value === 'log') return value
  return 'idea'
}

/**
 * 收敛截止日：只接受合法的 `YYYY-MM-DD`，其余一律当作「没设截止日」。
 *
 * 刻意不做「就近猜测」—— 猜错一天比干脆没有截止日更糟，
 * 因为它会安静地给出一个看起来正常、实际错误的倒计时。
 */
export function clampDeadlineLocalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return parseLocalDate(value) ? value : null
}

/**
 * 收敛 parentId：只接受非空字符串，其余一律当作「没有父级」。
 *
 * 远端可能给来 `''`（空字符串）、数字、甚至对象。空字符串尤其危险 ——
 * 它既不等于 null（`parentId === null` 判不出「没有父级」），
 * 又永远匹配不到任何大事的 id（进展会凭空消失，而且查不出原因）。
 */
export function clampParentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 记录类型在界面上的名字。
 *
 * 放在领域层而不是各页面各写一份三元表达式 —— 加第三种类型那次，
 * 正是靠这个才不会漏掉某个页面（搜索结果的类型标签就漏过一次）。
 */
export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  idea: '灵感',
  todo: '待办',
  project: '大事',
  log: '进展',
}

/** 列表里显示的类型标签：已完成的待办显示「已完成」，其余显示类型名 */
export function typeLabelOf(record: LocalRecord): string {
  if (record.type === 'todo' && record.completedAtUtc !== null) return '已完成'
  return RECORD_TYPE_LABEL[record.type]
}

// ---------------------------------------------------------------
// 观察方式（四个页面的语义，§6、§78、§79）
//
// ⚠️ 这里就是「进展不进首页」这条红线的**唯一实现点**。
//    加新记录类型时，只要有一个过滤器忘了排除，进展就会刷屏首页 /
//    日历 / 搜索 —— 而且不会报任何错。
// ---------------------------------------------------------------

/**
 * 首页：idea + todo + project，按创建时间倒序，已完成仍保留（视觉变淡）。
 *
 * **排除 log** —— 进展是大事的子记录，只在大事详情里看得到。
 * 首页回答的是「我什么时候记下了什么」，一屏里塞满「改了个 bug」
 * 会把真正的时间线淹掉。
 */
export function isOnTimeline(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type !== 'log'
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

/** 大事（首页那个独立模块的数据来源） */
export function isProject(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type === 'project'
}

/** 进展记录（大事详情里的那一条） */
export function isLog(record: LocalRecord): boolean {
  return record.deletedAtUtc === null && record.type === 'log'
}

/**
 * 某件大事下的进展。
 *
 * 父级被软删时进展**不跟着消失** —— 它自己的 deletedAtUtc 是独立的。
 * 这是刻意的：用户撤销「删除大事」之后，写过的进展要原样回来。
 * 真要一起清掉，那是「清空进展」这个动作该做的事，不该由父级连坐。
 */
export function isLogOf(record: LocalRecord, projectId: string): boolean {
  return isLog(record) && record.parentId === projectId
}

/**
 * 还在推进中的大事：进度没到 100。
 *
 * 「目前在做的大事」这个标题决定了语义 —— 已经推到 100 的就不是「在做」了。
 * 但它不会消失：首页时间线里仍然留着它，进度和截止日进详情能看到。
 */
export function isOpenProject(record: LocalRecord): boolean {
  return isProject(record) && progressOf(record) < PROGRESS_MAX
}

/**
 * 搜索：content 包含关键字，不含已删除（§61）。
 *
 * 同样**排除 log**：搜到一条「限位搞定了」却看不到它属于哪件大事，
 * 是个没有上下文的碎片。要找进展就打开那件大事。
 */
export function matchesQuery(record: LocalRecord, query: string): boolean {
  if (record.deletedAtUtc !== null) return false
  if (record.type === 'log') return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return record.content.toLowerCase().includes(q)
}

/**
 * 大事模块的排序：**截止日升序，最紧急的排最上**。
 *
 * 这个模块存在的唯一意义就是「打开就知道先干哪个」，所以排序必须由
 * 紧迫度决定，不能按创建时间。
 *
 * 没有截止日的排最后 —— 它们不紧迫，不该把有 deadline 的挤下去。
 * 截止日相同时按创建时间倒序兜底，保证顺序稳定（同一毫秒也不会乱跳）。
 */
export function byDeadlineAsc(a: LocalRecord, b: LocalRecord): number {
  const aDeadline = a.deadlineLocalDate
  const bDeadline = b.deadlineLocalDate
  if (aDeadline !== bDeadline) {
    if (aDeadline === null) return 1
    if (bDeadline === null) return -1
    return aDeadline < bDeadline ? -1 : 1
  }
  return byCreatedAtDesc(a, b)
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
    .toSorted((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({ date, items: items.toSorted(byCreatedAtDesc) }))
}
