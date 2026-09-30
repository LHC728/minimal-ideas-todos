import { useEffect, useState } from 'react'
import { usePendingCount } from '../hooks/useRecords'
import { useSyncStatus } from '../sync/syncStatus'

interface SyncIndicatorProps {
  userId: string | null
}

/**
 * 同步状态提示（§65、§66）。
 * 正常时什么都不显示；离线也仍然可以正常使用。
 */
export function SyncIndicator({ userId }: SyncIndicatorProps) {
  const status = useSyncStatus()
  const pending = usePendingCount(userId)

  // 同步完成的那一刻闪现 1.6 秒「已同步」。
  // 用「render 阶段状态对齐」代替 effect 内同步 setState：
  // 检测到新的 lastSyncedAt 就在渲染中记账，effect 只负责到点把它清掉。
  const [flashAt, setFlashAt] = useState<string | null>(null)
  const [seenSyncedAt, setSeenSyncedAt] = useState<string | null>(null)

  if (status.phase === 'synced' && status.lastSyncedAt && status.lastSyncedAt !== seenSyncedAt) {
    setSeenSyncedAt(status.lastSyncedAt)
    setFlashAt(status.lastSyncedAt)
  }

  useEffect(() => {
    if (flashAt === null) return
    const timer = setTimeout(() => setFlashAt(null), 1600)
    return () => clearTimeout(timer)
  }, [flashAt])

  const showSynced = flashAt !== null && status.lastSyncedAt === flashAt

  let text: string | null = null

  if (status.phase === 'local') {
    text = '仅本机'
  } else if (status.phase === 'signed-out') {
    text = null
  } else if (!status.online || status.phase === 'offline') {
    text = '离线'
  } else if (status.phase === 'syncing') {
    text = '正在同步…'
  } else if (status.phase === 'error') {
    text = status.message ?? '暂时无法同步，内容已经保存在本机。'
  } else if (showSynced) {
    text = '已同步'
  } else if (pending > 0) {
    text = '正在同步…'
  }

  if (!text) return <span className="hidden md:block" />

  return (
    <span
      className="truncate text-[12px] text-ink-soft"
      data-testid="sync-indicator"
      data-sync-phase={status.phase}
    >
      {text}
    </span>
  )
}
