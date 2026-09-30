import { useEffect } from 'react'
import { toaster, useToasts, type ToastItem } from '../app/toastStore'
import { useUi } from '../app/uiStore'

function ToastRow({ item }: { item: ToastItem }) {
  useEffect(() => {
    const timer = setTimeout(() => toaster.dismiss(item.id), item.duration)
    return () => clearTimeout(timer)
  }, [item.id, item.duration])

  return (
    <div className="animate-toast-in float-raised pointer-events-auto flex items-center gap-4 rounded-[12px] border border-line bg-surface px-4 py-2.5">
      <span className="text-[13px] text-ink-soft">{item.message}</span>
      {item.actionLabel ? (
        <button
          type="button"
          className="tap tap-active -mr-1 shrink-0 rounded-[8px] px-2 py-1 text-[13px] font-medium text-idea"
          onClick={() => {
            item.onAction?.()
            toaster.dismiss(item.id)
          }}
        >
          {item.actionLabel}
        </button>
      ) : null}
    </div>
  )
}

/**
 * 轻提示容器。
 *
 * 平时贴在底部（手机在底部导航上方，桌面在右下角）。
 * 但详情抽屉 / 搜索 / 设置打开时，底部被面板占满 ——
 * 提示会正好压在面板的操作按钮上，所以此时移到顶部。
 */
export function Toaster() {
  const items = useToasts()
  const ui = useUi()

  if (items.length === 0) return null

  const panelOpen = ui.selectedRecordId !== null || ui.searchOpen || ui.settingsOpen

  const position = panelOpen
    ? 'top-[calc(56px+env(safe-area-inset-top))] md:top-6'
    : 'bottom-[calc(72px+env(safe-area-inset-bottom))] md:bottom-6'

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:items-end ${position}`}
    >
      {items.slice(-2).map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  )
}
