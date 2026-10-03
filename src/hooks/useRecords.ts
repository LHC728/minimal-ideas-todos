/**
 * 记录查询与操作（方案 §28、§29）。
 *
 * 所有查询都直接读 IndexedDB —— UI 永远不等待网络。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  completeTodo,
  createRecord,
  restoreRecord,
  softDelete,
  uncompleteTodo,
  updateContent,
  updateDeadline,
  updateProjectProgress,
  type CreateRecordInput,
} from '../db/recordRepository'
import { countPending } from '../db/outboxRepository'
import type { LocalRecord, RecordType } from '../domain/record'
import {
  byCompletedAtDesc,
  byCreatedAtDesc,
  byDeadlineAsc,
  isDoneTodo,
  isIdea,
  isOnTimeline,
  isOpenProject,
  isOpenTodo,
  matchesQuery,
  PROGRESS_MAX,
} from '../domain/record'
import { syncEngine } from '../sync/SyncEngine'
import { countConflicts, resolveConflict, type ConflictChoice } from '../sync/ConflictService'

const EMPTY: LocalRecord[] = []

function sortDesc(records: LocalRecord[]): LocalRecord[] {
  return records.toSorted(byCreatedAtDesc)
}

/** 该用户全部记录（含软删除，同步层需要） */
export function useAllRecords(userId: string | null): LocalRecord[] {
  const records = useLiveQuery(
    async () => (userId ? db.records.where('userId').equals(userId).toArray() : EMPTY),
    [userId],
    EMPTY,
  )
  return records ?? EMPTY
}

/** 首页时间线：idea + todo，创建时间倒序，已完成仍保留（§78） */
export function useTimeline(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isOnTimeline))
}

/** 灵感页（§17） */
export function useIdeas(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isIdea))
}

/** 待办页：只显示未完成（§19、§79） */
export function useOpenTodos(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isOpenTodo))
}

/**
 * 待办页底部的「已完成」区：全部已完成的待办，按**完成时间**倒序。
 *
 * 它不是归档，是一块「后悔药」—— 手滑打勾之后能就地撤销。
 * 归档仍然归首页时间线和日历管，所以这里不做分组、不做时间窗。
 */
export function useDoneTodos(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return records.filter(isDoneTodo).toSorted(byCompletedAtDesc)
}

/**
 * 首页「目前在做的大事」。
 *
 * 排序是**截止日升序**（最紧急的在最上），不是创建时间 ——
 * 这块地方存在的意义就是「打开就知道先干哪个」。
 * 没设截止日的排最后。
 *
 * 推到 100% 的不在这里，但也不会消失：它仍在首页时间线里。
 */
export function useOpenProjects(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return records.filter(isOpenProject).toSorted(byDeadlineAsc)
}

/** 日历归档：按 created_local_date（§23、§24、§80） */
export function useRecordsOnDate(userId: string | null, localDate: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  if (!localDate) return EMPTY
  return sortDesc(records.filter((r) => r.deletedAtUtc === null && r.createdLocalDate === localDate))
}

/** 有记录的日期集合，用于月历小圆点 */
export function useRecordDates(userId: string | null): Set<string> {
  const records = useAllRecords(userId)
  const dates = new Set<string>()
  for (const record of records) {
    if (record.deletedAtUtc === null) dates.add(record.createdLocalDate)
  }
  return dates
}

export function useRecord(recordId: string | null): LocalRecord | undefined {
  return useLiveQuery(
    async () => (recordId ? db.records.get(recordId) : undefined),
    [recordId],
  )
}

export function useSearchResults(userId: string | null, query: string): LocalRecord[] {
  const records = useAllRecords(userId)
  if (!query.trim()) return EMPTY
  return sortDesc(records.filter((r) => matchesQuery(r, query)))
}

export function usePendingCount(userId: string | null): number {
  const count = useLiveQuery(
    async () => (userId ? countPending(userId) : 0),
    [userId],
    0,
  )
  return count ?? 0
}

export function useConflictCount(userId: string | null): number {
  const count = useLiveQuery(
    async () => (userId ? countConflicts(userId) : 0),
    [userId],
    0,
  )
  return count ?? 0
}

export function useConflicts(userId: string | null) {
  return useLiveQuery(
    async () => (userId ? db.conflicts.where('userId').equals(userId).toArray() : []),
    [userId],
    [],
  )
}

// ---------------------------------------------------------------
// 操作：UI 只通过这里写数据
// ---------------------------------------------------------------

async function afterWrite(): Promise<void> {
  syncEngine.notifyLocalChange()
}

export const recordActions = {
  async create(input: CreateRecordInput): Promise<LocalRecord> {
    const record = await createRecord(input)
    await afterWrite()
    return record
  },

  /** 记录成本最低：打开 → 输入 → 点「灵感」或「待办」→ 完成（§8） */
  async quickCapture(userId: string, content: string, type: RecordType): Promise<LocalRecord> {
    const record = await createRecord({ userId, type, content })
    await afterWrite()
    return record
  },

  async updateContent(recordId: string, content: string): Promise<void> {
    await updateContent(recordId, content)
    await afterWrite()
  },

  /** 大事进度。调用方负责在**松手时**调一次，不要跟着滑块连续调。 */
  async setProgress(recordId: string, progress: number): Promise<void> {
    await updateProjectProgress(recordId, progress)
    await afterWrite()
  },

  /** 一键把大事推到 100%（详情里的「完成」按钮） */
  async finishProject(recordId: string): Promise<void> {
    await updateProjectProgress(recordId, PROGRESS_MAX)
    await afterWrite()
  },

  /** 设置 / 清除大事截止日；传 null 清除 */
  async setDeadline(recordId: string, deadlineLocalDate: string | null): Promise<void> {
    await updateDeadline(recordId, deadlineLocalDate)
    await afterWrite()
  },

  async complete(recordId: string): Promise<void> {
    await completeTodo(recordId)
    await afterWrite()
  },

  async uncomplete(recordId: string): Promise<void> {
    await uncompleteTodo(recordId)
    await afterWrite()
  },

  async remove(recordId: string): Promise<void> {
    await softDelete(recordId)
    await afterWrite()
  },

  async restore(recordId: string): Promise<void> {
    await restoreRecord(recordId)
    await afterWrite()
  },

  async resolveConflict(recordId: string, choice: ConflictChoice, editedContent?: string): Promise<void> {
    await resolveConflict(recordId, choice, editedContent)
    await afterWrite()
  },
}
