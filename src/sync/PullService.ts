/**
 * Pull（方案 §44 - §46）。
 *
 * V1 数据量很小，不做复杂 cursor 协议：直接做该用户 Record 的完整对账拉取，
 * 且必须包含软删除 Tombstone —— 否则离线设备会把已删除记录「复活」。
 */
import type { CloudAdapter } from '../cloud/CloudAdapter'
import type { CloudRecord } from '../domain/record'

export async function pullAll(adapter: CloudAdapter, userId: string): Promise<CloudRecord[]> {
  if (!adapter.isConfigured()) return []
  return adapter.pullAll(userId)
}

export async function pullOne(
  adapter: CloudAdapter,
  userId: string,
  recordId: string,
): Promise<CloudRecord | null> {
  if (!adapter.isConfigured()) return null
  return adapter.pullOne(userId, recordId)
}
