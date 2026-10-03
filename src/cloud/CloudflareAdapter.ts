/**
 * Cloudflare 实现（自建 Worker + D1）。
 *
 * 与 SupabaseAdapter 语义完全等价，差异只有两点：
 *   1. 传输：走自建 Worker 的 REST 接口，而不是 supabase-js
 *   2. 实时：Worker 没有 Realtime 通道，subscribe 返回空取消函数
 *      —— 这不影响正确性。Realtime 在本项目里只是「加速器」（§55），
 *      正确性由 Pull → Reconcile → Push → Pull 的同步循环保证。
 */
import type { CloudRecord, RecordType } from '../domain/record'
import { clampDeadlineLocalDate, clampProgress, clampRecordType } from '../domain/record'
import type { ApplyMutationParams, ApplyMutationResult, CloudAdapter } from './CloudAdapter'
import { cfRequest, getCloudflareClient } from './cloudflareClient'

type Row = Record<string, unknown>

function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

/** 网络来的东西一律当作不可信，逐个字段归一后再进领域层 */
function toCloud(row: Row): CloudRecord {
  const type: RecordType = clampRecordType(row.type)
  const version = Number(row.version)
  return {
    id: asString(row.id),
    userId: asString(row.userId),
    type,
    content: asString(row.content),
    progress: clampProgress(row.progress),
    deadlineLocalDate: clampDeadlineLocalDate(row.deadlineLocalDate),
    createdAtUtc: asString(row.createdAtUtc),
    createdTimezone: asString(row.createdTimezone, 'UTC'),
    createdLocalDate: asString(row.createdLocalDate),
    updatedAtUtc: asString(row.updatedAtUtc),
    updatedTimezone: asString(row.updatedTimezone, 'UTC'),
    completedAtUtc: asNullableString(row.completedAtUtc),
    completedTimezone: asNullableString(row.completedTimezone),
    deletedAtUtc: asNullableString(row.deletedAtUtc),
    version: Number.isFinite(version) ? version : 1,
    serverUpdatedAt: asString(row.serverUpdatedAt),
  }
}

export class CloudflareAdapter implements CloudAdapter {
  readonly kind = 'cloudflare'

  isConfigured(): boolean {
    return getCloudflareClient() !== null
  }

  /**
   * 拉取全部记录。
   *
   * userId 用不上 —— 服务端从令牌就能确定身份，多传一个反而是个
   * 「客户端说是谁就是谁」的口子。但签名必须与 CloudAdapter 一致，
   * 否则调用方按接口传参会在类型层面报错。
   */
  async pullAll(_userId: string): Promise<CloudRecord[]> {
    const data = await cfRequest<{ records?: Row[] }>('/api/sync/pull', { method: 'POST' })
    const rows = data.records ?? []
    return rows.map(toCloud)
  }

  async pullOne(_userId: string, recordId: string): Promise<CloudRecord | null> {
    const data = await cfRequest<{ record?: Row | null }>(
      `/api/sync/record?id=${encodeURIComponent(recordId)}`,
    )
    return data.record ? toCloud(data.record) : null
  }

  async applyMutation(_userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult> {
    const data = await cfRequest<{
      status?: string
      version?: number | string | null
      record?: Row | null
    }>('/api/sync/mutate', {
      method: 'POST',
      body: {
        mutationId: params.mutationId,
        recordId: params.recordId,
        operation: params.operation,
        expectedVersion: params.expectedVersion,
        payload: params.payload,
      },
    })

    const status =
      data.status === 'already_applied' ||
      data.status === 'version_conflict' ||
      data.status === 'record_not_found'
        ? data.status
        : 'applied'

    return {
      status,
      version:
        data.version === null || data.version === undefined ? null : Number(data.version),
      record: data.record ? toCloud(data.record) : null,
    }
  }

  /**
   * Worker 没有推送通道。同步循环会兜住一致性，这里返回空取消函数即可。
   *
   * 参数按 CloudAdapter 的契约保留（不能省）：省掉之后调用方按接口传参
   * 就会报「Expected 0 arguments」—— 那是个只在类型层面存在的假故障。
   */
  subscribe(_userId: string, _onChange: (recordId: string) => void): () => void {
    return () => undefined
  }
}

export const cloudflareAdapter = new CloudflareAdapter()
