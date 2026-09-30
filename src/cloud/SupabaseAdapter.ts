/**
 * Supabase 实现（方案 §27、§32、§40、§41、§54）。
 *
 * - 全部读取都带 user_id 过滤，并且服务端 RLS 再兜一层（§64）
 * - 写入一律走 apply_record_mutation RPC：数据库端原子完成
 *   「检查 version → 应用 mutation → version + 1 → 记录 applied_mutations」
 */
import type { CloudRecord, RecordType } from '../domain/record'
import type {
  ApplyMutationParams,
  ApplyMutationResult,
  CloudAdapter,
} from './CloudAdapter'
import { getSupabaseClient } from './supabaseClient'

const COLUMNS = [
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
].join(',')

type Row = Record<string, unknown>

function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function toCloud(row: Row): CloudRecord {
  const type: RecordType = row.type === 'todo' ? 'todo' : 'idea'
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    type,
    content: asString(row.content),
    createdAtUtc: asString(row.created_at_utc),
    createdTimezone: asString(row.created_timezone, 'UTC'),
    createdLocalDate: asString(row.created_local_date),
    updatedAtUtc: asString(row.updated_at_utc),
    updatedTimezone: asString(row.updated_timezone, 'UTC'),
    completedAtUtc: asNullableString(row.completed_at_utc),
    completedTimezone: asNullableString(row.completed_timezone),
    deletedAtUtc: asNullableString(row.deleted_at_utc),
    version: Number(row.version ?? 1),
    serverUpdatedAt: asString(row.server_updated_at),
  }
}

const PAGE_SIZE = 500

export class SupabaseAdapter implements CloudAdapter {
  readonly kind = 'supabase'

  isConfigured(): boolean {
    return getSupabaseClient() !== null
  }

  private client() {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    return client
  }

  async pullAll(userId: string): Promise<CloudRecord[]> {
    const client = this.client()
    const result: CloudRecord[] = []

    for (let from = 0; from < 200000; from += PAGE_SIZE) {
      const { data, error } = await client
        .from('records')
        .select(COLUMNS)
        .eq('user_id', userId)
        .order('server_updated_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)

      if (error) throw new Error(error.message)
      const rows = (data ?? []) as unknown as Row[]
      for (const row of rows) result.push(toCloud(row))
      if (rows.length < PAGE_SIZE) break
    }

    return result
  }

  async pullOne(userId: string, recordId: string): Promise<CloudRecord | null> {
    const client = this.client()
    const { data, error } = await client
      .from('records')
      .select(COLUMNS)
      .eq('user_id', userId)
      .eq('id', recordId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    return toCloud(data as unknown as Row)
  }

  async applyMutation(_userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult> {
    const client = this.client()
    const { data, error } = await client.rpc('apply_record_mutation', {
      p_mutation_id: params.mutationId,
      p_record_id: params.recordId,
      p_operation: params.operation,
      p_expected_version: params.expectedVersion,
      p_payload: params.payload,
    })

    if (error) throw new Error(error.message)

    const payload = (data ?? {}) as {
      status?: string
      version?: number | string | null
      record?: Row | null
    }

    const status =
      payload.status === 'already_applied' ||
      payload.status === 'version_conflict' ||
      payload.status === 'record_not_found'
        ? payload.status
        : 'applied'

    return {
      status,
      version: payload.version === null || payload.version === undefined ? null : Number(payload.version),
      record: payload.record ? toCloud(payload.record) : null,
    }
  }

  subscribe(userId: string, onChange: (recordId: string) => void): () => void {
    const client = getSupabaseClient()
    if (!client) return () => undefined

    const channel = client
      .channel(`records:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'records',
          filter: `user_id=eq.${userId}`,
        },
        (event: { new?: Row; old?: Row }) => {
          const row = event.new && Object.keys(event.new).length > 0 ? event.new : event.old
          const id = row?.id
          if (id) onChange(String(id))
        },
      )
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }
}

/** 未配置云端时使用的空实现：一切同步操作静默跳过，本地照常可用 */
export class NullAdapter implements CloudAdapter {
  readonly kind = 'null'

  isConfigured(): boolean {
    return false
  }

  async pullAll(): Promise<CloudRecord[]> {
    return []
  }

  async pullOne(): Promise<CloudRecord | null> {
    return null
  }

  async applyMutation(): Promise<ApplyMutationResult> {
    return { status: 'record_not_found', version: null, record: null }
  }

  subscribe(): () => void {
    return () => undefined
  }
}

export const supabaseAdapter = new SupabaseAdapter()
export const nullAdapter = new NullAdapter()

// 适配器的分发已经移到 cloudProvider.ts ——
// 这里再留一份会变成两个入口，迟早有人改了一处忘了另一处。
