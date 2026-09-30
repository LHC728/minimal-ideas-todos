/**
 * 同步状态（方案 §65、§66）。
 *
 * 对用户只说人话：
 *   正常 → 不显示
 *   同步中 → 「正在同步…」
 *   离线 → 「离线」但仍可正常使用
 *   失败 → 「暂时无法同步，内容已经保存在本机。」
 */
import { useSyncExternalStore } from 'react'

export type SyncPhase =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'
  | 'local'
  | 'signed-out'

export interface SyncStatus {
  phase: SyncPhase
  /** 面向用户的说明文案，不暴露 HTTP / RPC 细节 */
  message: string | null
  lastSyncedAt: string | null
  online: boolean
  /** 当前连续失败次数，用于退避 */
  failureCount: number
}

const INITIAL: SyncStatus = {
  phase: 'idle',
  message: null,
  lastSyncedAt: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  failureCount: 0,
}

class SyncStatusStore {
  private listeners = new Set<() => void>()
  private state: SyncStatus = INITIAL

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): SyncStatus => this.state

  set(patch: Partial<SyncStatus>): void {
    const next = { ...this.state, ...patch }
    if (
      next.phase === this.state.phase &&
      next.message === this.state.message &&
      next.lastSyncedAt === this.state.lastSyncedAt &&
      next.online === this.state.online &&
      next.failureCount === this.state.failureCount
    ) {
      return
    }
    this.state = next
    for (const listener of this.listeners) listener()
  }

  reset(): void {
    this.set({ ...INITIAL })
  }
}

export const syncStatusStore = new SyncStatusStore()

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(syncStatusStore.subscribe, syncStatusStore.getSnapshot, syncStatusStore.getSnapshot)
}

export const FRIENDLY_SYNC_ERROR = '暂时无法同步，内容已经保存在本机。'
