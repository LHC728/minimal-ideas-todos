/**
 * 测试用的内存版云服务，行为与 supabase/migrations/0001_init.sql 中的
 * apply_record_mutation 保持一致：
 *   - version 原子检查
 *   - mutationId 幂等
 *   - 记录不存在时返回 record_not_found
 *   - 按 user_id 隔离
 *   - 可模拟「服务器已成功但响应丢失」和断网
 */
import type {
  ApplyMutationParams,
  ApplyMutationResult,
  CloudAdapter,
} from '../cloud/CloudAdapter'
import type { CloudRecord, RecordType } from '../domain/record'
import { clampDeadlineLocalDate, clampProgress, clampRecordType } from '../domain/record'
import { AppDatabase, setActiveDatabase } from '../db/db'

export class FakeCloudServer implements CloudAdapter {
  readonly kind = 'fake'

  rows = new Map<string, CloudRecord>()
  applied = new Map<string, { userId: string; version: number }>()

  /** 下一次写入会被服务器执行，但客户端收不到响应（模拟返回包丢失） */
  dropNextResponse = false
  /** 模拟断网 */
  offline = false
  /** 模拟服务端异常 */
  failNext = false

  /** 记录所有收到的 mutationId，便于断言「只生效一次」 */
  received: string[] = []

  /** 完整的请求历史，便于排查同步顺序问题 */
  history: {
    mutationId: string
    userId: string
    recordId: string
    operation: string
    expectedVersion: number | null
    payload: Record<string, unknown>
  }[] = []

  private subscribers = new Map<string, Set<(recordId: string) => void>>()
  private clock = Date.parse('2026-09-30T00:00:00.000Z')

  isConfigured(): boolean {
    return true
  }

  private now(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  private notify(userId: string, recordId: string): void {
    for (const handler of this.subscribers.get(userId) ?? []) handler(recordId)
  }

  async pullAll(userId: string): Promise<CloudRecord[]> {
    if (this.offline) throw new Error('network_unavailable')
    return Array.from(this.rows.values())
      .filter((row) => row.userId === userId)
      // 深拷贝：模拟真实的网络边界，本地改动绝不能透过引用影响「服务器」
      .map((row) => structuredClone(row))
  }

  async pullOne(userId: string, recordId: string): Promise<CloudRecord | null> {
    if (this.offline) throw new Error('network_unavailable')
    const row = this.rows.get(recordId)
    if (!row || row.userId !== userId) return null
    return { ...row }
  }

  async applyMutation(userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult> {
    if (this.offline) throw new Error('network_unavailable')
    if (this.failNext) {
      this.failNext = false
      throw new Error('server_error')
    }

    this.received.push(params.mutationId)
    this.history.push({
      mutationId: params.mutationId,
      userId,
      recordId: params.recordId,
      operation: params.operation,
      expectedVersion: params.expectedVersion,
      payload: params.payload,
    })

    // 幂等：同一个 mutationId 只生效一次
    const done = this.applied.get(params.mutationId)
    if (done) {
      const row = this.rows.get(params.recordId) ?? null
      return {
        status: 'already_applied',
        version: row?.version ?? done.version,
        record: row ? { ...row } : null,
      }
    }

    const current = this.rows.get(params.recordId)

    if (!current) {
      if (params.operation !== 'create') {
        return { status: 'record_not_found', version: null, record: null }
      }
      const created = this.buildFromCreate(userId, params)
      this.rows.set(created.id, created)
      this.applied.set(params.mutationId, { userId, version: created.version })
      this.notify(userId, created.id)
      return this.maybeDrop({ status: 'applied', version: created.version, record: { ...created } })
    }

    if (current.userId !== userId) {
      // RLS：读不到别的用户的行
      return { status: 'record_not_found', version: null, record: null }
    }

    if (params.expectedVersion === null || params.expectedVersion !== current.version) {
      return { status: 'version_conflict', version: current.version, record: { ...current } }
    }

    const next = this.applyPatch(current, params.payload)
    next.version = current.version + 1
    next.serverUpdatedAt = this.now()
    this.rows.set(next.id, next)
    this.applied.set(params.mutationId, { userId, version: next.version })
    this.notify(userId, next.id)
    return this.maybeDrop({ status: 'applied', version: next.version, record: { ...next } })
  }

  subscribe(userId: string, onChange: (recordId: string) => void): () => void {
    const set = this.subscribers.get(userId) ?? new Set()
    set.add(onChange)
    this.subscribers.set(userId, set)
    return () => {
      set.delete(onChange)
    }
  }

  /** 手动触发一次 Realtime 事件（模拟漏发/补发） */
  emit(userId: string, recordId: string): void {
    this.notify(userId, recordId)
  }

  reset(): void {
    this.rows.clear()
    this.applied.clear()
    this.subscribers.clear()
    this.received = []
    this.history = []
    this.dropNextResponse = false
    this.offline = false
    this.failNext = false
    this.clock = Date.parse('2026-09-30T00:00:00.000Z')
  }

  private maybeDrop(result: ApplyMutationResult): ApplyMutationResult {
    if (!this.dropNextResponse) return result
    this.dropNextResponse = false
    // 服务器已经写成功，但客户端收不到响应
    throw new Error('response_lost')
  }

  private buildFromCreate(userId: string, params: ApplyMutationParams): CloudRecord {
    const p = params.payload as Record<string, unknown>
    const type: RecordType = clampRecordType(p.type)
    // 与真实后端一致：非大事的 progress / deadline 一律丢弃
    const isProject = type === 'project'
    return {
      id: params.recordId,
      userId,
      type,
      content: typeof p.content === 'string' ? p.content : '',
      progress: isProject ? clampProgress(p.progress) : null,
      deadlineLocalDate: isProject ? clampDeadlineLocalDate(p.deadlineLocalDate) : null,
      createdAtUtc: String(p.createdAtUtc ?? this.now()),
      createdTimezone: String(p.createdTimezone ?? 'Asia/Shanghai'),
      createdLocalDate: String(p.createdLocalDate ?? '2026-09-30'),
      updatedAtUtc: String(p.updatedAtUtc ?? p.createdAtUtc ?? this.now()),
      updatedTimezone: String(p.updatedTimezone ?? p.createdTimezone ?? 'Asia/Shanghai'),
      completedAtUtc: p.completedAtUtc ? String(p.completedAtUtc) : null,
      completedTimezone: p.completedTimezone ? String(p.completedTimezone) : null,
      deletedAtUtc: p.deletedAtUtc ? String(p.deletedAtUtc) : null,
      version: 1,
      serverUpdatedAt: this.now(),
    }
  }

  private applyPatch(row: CloudRecord, payload: Record<string, unknown>): CloudRecord {
    const next: CloudRecord = { ...row }
    if (typeof payload.content === 'string') next.content = payload.content
    // 与真实后端一致：只有大事才接受 progress / deadline
    if (row.type === 'project') {
      if ('progress' in payload) next.progress = clampProgress(payload.progress)
      if ('deadlineLocalDate' in payload) {
        next.deadlineLocalDate = clampDeadlineLocalDate(payload.deadlineLocalDate)
      }
    }
    if (typeof payload.updatedAtUtc === 'string') next.updatedAtUtc = payload.updatedAtUtc
    if (typeof payload.updatedTimezone === 'string') next.updatedTimezone = payload.updatedTimezone
    if ('completedAtUtc' in payload) {
      next.completedAtUtc = payload.completedAtUtc ? String(payload.completedAtUtc) : null
    }
    if ('completedTimezone' in payload) {
      next.completedTimezone = payload.completedTimezone ? String(payload.completedTimezone) : null
    }
    if ('deletedAtUtc' in payload) {
      next.deletedAtUtc = payload.deletedAtUtc ? String(payload.deletedAtUtc) : null
    }
    return next
  }
}

// ---------------------------------------------------------------
// 多设备模拟
// ---------------------------------------------------------------

const devices: AppDatabase[] = []

/** 切换到一台全新的「设备」（独立 IndexedDB） */
export async function openDevice(name: string): Promise<AppDatabase> {
  const database = new AppDatabase(name)
  await database.delete().catch(() => undefined)
  await database.open()
  devices.push(database)
  setActiveDatabase(database)
  return database
}

/** 模拟浏览器刷新：关闭并重新打开同一个数据库 */
export async function reopenDevice(database: AppDatabase): Promise<void> {
  database.close()
  setActiveDatabase(database)
  await database.open()
}

export async function cleanupDevices(): Promise<void> {
  for (const database of devices.splice(0)) {
    try {
      database.close()
      await database.delete()
    } catch {
      // ignore
    }
  }
}
