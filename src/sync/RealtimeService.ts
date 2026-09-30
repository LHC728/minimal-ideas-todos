/**
 * Realtime（方案 §54、§55）。
 *
 * Realtime 只是加速器，不是同步真相来源：
 * 浏览器会休眠、手机会杀后台、WebSocket 会重连。
 * 最终一致性始终依赖 Pull + Reconcile。
 */
import type { CloudAdapter } from '../cloud/CloudAdapter'

export class RealtimeService {
  private unsubscribe: (() => void) | null = null
  private currentKey: string | null = null

  start(adapter: CloudAdapter, userId: string, onRecordChanged: (recordId: string) => void): void {
    const key = `${adapter.kind}:${userId}`
    if (this.currentKey === key && this.unsubscribe) return
    this.stop()

    if (!adapter.isConfigured()) return

    try {
      this.unsubscribe = adapter.subscribe(userId, (recordId) => {
        onRecordChanged(recordId)
      })
      this.currentKey = key
    } catch {
      this.unsubscribe = null
      this.currentKey = null
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.currentKey = null
  }

  get active(): boolean {
    return this.unsubscribe !== null
  }
}
