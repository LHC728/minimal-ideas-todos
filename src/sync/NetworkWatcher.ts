/**
 * 网络与前台恢复监听（方案 §56）。
 *
 * 触发源：online / offline、visibilitychange、focus、pageshow。
 * 前台恢复要节流，不要每次 focus 都疯狂请求。
 */

export type SyncTriggerReason =
  | 'startup'
  | 'online'
  | 'offline'
  | 'foreground'
  | 'manual'
  | 'realtime'
  | 'retry'
  | 'local-change'

/** 前台恢复触发的最小间隔（§56：30～60 秒） */
export const FOREGROUND_THROTTLE_MS = 45_000

export class NetworkWatcher {
  private handler: ((reason: SyncTriggerReason) => void) | null = null
  private lastForegroundAt = 0
  private started = false

  private onOnline = () => this.handler?.('online')
  private onOffline = () => this.handler?.('offline')
  private onVisibility = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'visible') this.foreground()
  }
  private onFocus = () => this.foreground()
  private onPageShow = () => this.foreground()

  private foreground(): void {
    const now = Date.now()
    if (now - this.lastForegroundAt < FOREGROUND_THROTTLE_MS) return
    this.lastForegroundAt = now
    this.handler?.('foreground')
  }

  start(handler: (reason: SyncTriggerReason) => void): void {
    if (this.started) return
    this.started = true
    this.handler = handler
    if (typeof window === 'undefined') return

    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('pageshow', this.onPageShow)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.handler = null
    if (typeof window === 'undefined') return

    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('pageshow', this.onPageShow)
    document.removeEventListener('visibilitychange', this.onVisibility)
  }
}

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}
