/**
 * Mutation —— 本地变化的同步单元（方案 §34、§35）。
 *
 * 每次本地变化同时写 Record + Mutation，且必须落在同一个 IndexedDB transaction 里，
 * 避免「Record 改好了，但同步任务没保存下来」。
 */
import type { RecordSnapshot, RecordType } from './record'

export type MutationOperation =
  | 'create'
  | 'update'
  | 'complete'
  | 'uncomplete'
  | 'delete'
  | 'restore'

export type MutationState = 'pending' | 'sending' | 'failed'

/** 只包含“变化了的字段”的补丁 */
export interface MutationPayload {
  type?: RecordType
  content?: string
  createdAtUtc?: string
  createdTimezone?: string
  createdLocalDate?: string
  updatedAtUtc?: string
  updatedTimezone?: string
  completedAtUtc?: string | null
  completedTimezone?: string | null
  deletedAtUtc?: string | null
}

export interface Mutation {
  mutationId: string
  userId: string
  recordId: string
  operation: MutationOperation
  /** 提交时期望的服务器版本；create 为 null */
  baseServerVersion: number | null
  /** 修改前的基线快照，冲突处理的关键（§36） */
  baseSnapshot: RecordSnapshot
  payload: MutationPayload
  createdAt: string
  retryCount: number
  state: MutationState
}

/** 合并两个补丁，后者优先 */
export function mergePayload(a: MutationPayload, b: MutationPayload): MutationPayload {
  return { ...a, ...b }
}

/** 补丁是否为空 */
export function isEmptyPayload(payload: MutationPayload): boolean {
  return Object.keys(payload).length === 0
}

/**
 * 压缩规则（§58）：
 * 同一条记录、尚未发送的连续修改，压缩成一个最终 Mutation。
 * baseServerVersion / baseSnapshot 必须保留最初那一份。
 */
const OPERATION_PRIORITY: Record<MutationOperation, number> = {
  create: 6, // create 一旦存在就保持，服务端走 INSERT 路径
  delete: 5,
  restore: 4,
  complete: 3,
  uncomplete: 3,
  update: 1,
}

export function pickOperation(a: MutationOperation, b: MutationOperation): MutationOperation {
  return OPERATION_PRIORITY[a] >= OPERATION_PRIORITY[b] ? a : b
}

export function canCompress(existing: Mutation, incoming: Mutation): boolean {
  return (
    existing.recordId === incoming.recordId &&
    existing.userId === incoming.userId &&
    existing.state === 'pending'
  )
}

export function compressMutations(existing: Mutation, incoming: Mutation): Mutation {
  const operation = pickOperation(existing.operation, incoming.operation)
  const payload = mergePayload(existing.payload, incoming.payload)

  // create 路径需要完整字段，补齐不可变字段
  if (operation === 'create') {
    payload.type = incoming.payload.type ?? existing.payload.type ?? existing.baseSnapshot.type
    payload.createdAtUtc = existing.baseSnapshot.createdAtUtc || payload.createdAtUtc
    payload.createdTimezone = existing.baseSnapshot.createdTimezone || payload.createdTimezone
    payload.createdLocalDate = existing.baseSnapshot.createdLocalDate || payload.createdLocalDate
  }

  return {
    ...existing,
    operation,
    payload,
    // baseServerVersion / baseSnapshot 保持最初那一份（§58）
    retryCount: 0,
    state: 'pending',
  }
}
