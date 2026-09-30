/**
 * SyncEngine（方案 §44 - §46、§54 - §57、§65 - §67）。
 *
 * 顺序固定为：Pull → Reconcile → Push → Pull / 应用服务器返回结果
 * 绝不采用简单的 Push → Pull，也绝不采用 Last Write Wins。
 */
import type { CloudAdapter } from '../cloud/CloudAdapter'
import { createCloudAdapter } from '../cloud/cloudProvider'
import type { AuthMode } from '../auth/AuthService'
import { pullAll, pullOne } from './PullService'
import { reconcileMany, reconcileOne } from './ReconcileService'
import { pushPending, resetStaleSending } from './PushService'
import { RealtimeService } from './RealtimeService'
import { NetworkWatcher, isOnline, type SyncTriggerReason } from './NetworkWatcher'
import { FRIENDLY_SYNC_ERROR, syncStatusStore } from './syncStatus'
import { nowIso } from '../utils/time'

/** 退避阶梯（§67）：之后不再无限高频请求 */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

interface EngineConfig {
  adapter: CloudAdapter
  userId: string | null
  mode: AuthMode
}

class SyncEngine {
  private adapter: CloudAdapter = createCloudAdapter()
  private userId: string | null = null
  private mode: AuthMode = 'local'

  private running = false
  private rerunRequested = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private backoffIndex = 0
  private lastFullSyncAt = 0
  private started = false
  /** 在途的 Realtime 处理任务，用于「等待收敛」 */
  private pendingRealtime = new Set<Promise<void>>()

  private realtime = new RealtimeService()
  private network = new NetworkWatcher()

  /** 供 UI / 测试观察 */
  onAfterSync: (() => void) | null = null

  configure(config: Partial<EngineConfig>): void {
    if (config.adapter) this.adapter = config.adapter
    if ('userId' in config) this.userId = config.userId ?? null
    if (config.mode) this.mode = config.mode
    this.refreshRealtime()
    this.refreshIdlePhase()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.network.start((reason) => {
      if (reason === 'offline') {
        syncStatusStore.set({ phase: 'offline', online: false, message: null })
        return
      }
      syncStatusStore.set({ online: true })
      void this.sync(reason)
    })
    void this.sync('startup')
  }

  stop(): void {
    this.started = false
    this.running = false
    this.rerunRequested = false
    this.pendingRealtime.clear()
    this.network.stop()
    this.realtime.stop()
    this.clearRetry()
  }

  /** 云端未配置 / 未登录时，明确告诉 UI 当前处于什么状态 */
  private refreshIdlePhase(): void {
    if (!this.adapter.isConfigured()) {
      syncStatusStore.set({ phase: 'local', message: null })
      return
    }
    if (this.mode === 'cloud' && !this.userId) {
      syncStatusStore.set({ phase: 'signed-out', message: null })
      return
    }
    if (!this.running) {
      syncStatusStore.set({ phase: syncStatusStore.getSnapshot().phase === 'local' ? 'idle' : syncStatusStore.getSnapshot().phase })
    }
  }

  private refreshRealtime(): void {
    if (!this.adapter.isConfigured() || !this.userId) {
      this.realtime.stop()
      return
    }
    this.realtime.start(this.adapter, this.userId, (recordId) => {
      this.handleRealtimeHit(recordId)
    })
  }

  /**
   * Realtime 命中：只做一次定点 Pull + Reconcile。
   * 即使这条事件丢了，下一次完整 sync 也能补回来（§55）。
   */
  private handleRealtimeHit(recordId: string): void {
    const task = this.runRealtimeHit(recordId).finally(() => {
      this.pendingRealtime.delete(task)
    })
    this.pendingRealtime.add(task)
  }

  private async runRealtimeHit(recordId: string): Promise<void> {
    if (!this.userId || !this.adapter.isConfigured()) return
    try {
      const cloud = await pullOne(this.adapter, this.userId, recordId)
      if (cloud) await reconcileOne(cloud)
      // Realtime 之后可能还有本机待发送改动
      void this.sync('realtime')
    } catch {
      // 忽略：最终一致性由 Pull 保证
    }
  }

  /**
   * 等待同步彻底收敛（当前同步 + 排队中的同步 + 在途 Realtime 处理）。
   * 供测试与「立即同步」按钮确认结果使用。
   */
  async waitIdle(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.pendingRealtime.size > 0) {
        await Promise.allSettled(Array.from(this.pendingRealtime))
        continue
      }
      if (!this.running && !this.rerunRequested) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async sync(_reason: SyncTriggerReason): Promise<void> {
    if (!this.adapter.isConfigured()) {
      syncStatusStore.set({ phase: 'local', message: null })
      return
    }
    if (!this.userId) {
      syncStatusStore.set({ phase: 'signed-out', message: null })
      return
    }
    if (this.running) {
      this.rerunRequested = true
      return
    }

    this.running = true
    syncStatusStore.set({
      phase: 'syncing',
      message: null,
      online: isOnline(),
    })

    try {
      await this.runSync()
      this.backoffIndex = 0
      this.lastFullSyncAt = Date.now()
      syncStatusStore.set({
        phase: 'synced',
        message: null,
        lastSyncedAt: nowIso(),
        online: true,
        failureCount: 0,
      })
      this.onAfterSync?.()
    } catch (error) {
      const online = isOnline()
      const failureCount = this.backoffIndex + 1
      syncStatusStore.set({
        phase: online ? 'error' : 'offline',
        // 用户只需要知道最重要的信息：内容还在本机（§66）
        message: online ? FRIENDLY_SYNC_ERROR : null,
        online,
        failureCount,
      })
      this.scheduleRetry()
      void error
    } finally {
      this.running = false
      if (this.rerunRequested) {
        this.rerunRequested = false
        // sync() 会在第一个 await 之前同步把 running 置回 true，不存在空窗
        void this.sync('local-change')
      }
    }
  }

  /** Pull → Reconcile → Push → Pull */
  private async runSync(): Promise<void> {
    const userId = this.userId
    if (!userId) return

    await resetStaleSending(userId)

    // 1) Pull：先拿服务器最新状态（§45）
    const clouds = await pullAll(this.adapter, userId)

    // 2) Reconcile：决定采用 / 保留本机 / 自动合并 / 冲突
    await reconcileMany(clouds)

    // 3) Push：把本机改动送上去
    let pushError: unknown = null
    try {
      await pushPending(this.adapter, userId)
    } catch (error) {
      pushError = error
    }

    // 4) 再 Pull 一次，应用服务器返回结果并补齐可能的遗漏
    const after = await pullAll(this.adapter, userId)
    await reconcileMany(after)

    if (pushError) throw pushError
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (!this.started) return
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]
    if (this.backoffIndex >= BACKOFF_MS.length) return // 不再无限高频请求
    this.backoffIndex += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.sync('retry')
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /** 本地发生写入后调用，做一次轻量同步（带节流） */
  notifyLocalChange(): void {
    if (!this.started) return
    void this.sync('local-change')
  }

  get lastSyncAt(): number {
    return this.lastFullSyncAt
  }
}

export const syncEngine = new SyncEngine()
