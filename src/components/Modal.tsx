import { useEffect, type ReactNode } from 'react'
import { ChevronLeft, X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children?: ReactNode
  footer?: ReactNode
  /** 桌面端最大宽度 */
  widthClass?: string
  /**
   * 子页返回。给了就在标题左边多一个返回箭头。
   * 设为可选，是为了让「设置 → 云端连接」这种二级页不必为此单开一个组件，
   * 同时不影响已有的一级用法（详情 / 搜索 / 冲突）。
   */
  // 显式带上 `| undefined`：`exactOptionalPropertyTypes` 下，调用方写
  // `onBack={条件 ? fn : undefined}` 才算合法。
  onBack?: (() => void) | undefined
}

/**
 * 手机：底部抽屉；桌面：居中弹层。
 * 详情不是硬要求做三栏布局，数据正确优先于桌面布局炫技（§71）。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = 'md:max-w-lg',
  onBack,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-center">
      <div
        className="animate-fade-in absolute inset-0 bg-scrim"
        onClick={onClose}
        aria-hidden
      />
      <div
        // 用 role=dialog 而非原生 <dialog>：这里需要「手机上从底部升起、
        // 桌面上居中」的受控动画，原生 dialog 的 top-layer 会打断过渡。
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="dialog"
        aria-modal="true"
        className={`animate-sheet-up relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface md:rounded-2xl ${widthClass}`}
      >
        {title ? (
          <div className="flex items-center justify-between gap-4 border-b border-line-soft px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-0.5">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="返回"
                  className="tap tap-active -ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-soft"
                >
                  <ChevronLeft size={18} strokeWidth={1.8} />
                </button>
              ) : null}
              <h2 className="truncate text-[15px] font-medium text-ink">{title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="tap tap-active -mr-2 flex h-9 w-9 items-center justify-center rounded-lg text-ink-faint"
            >
              <X size={18} strokeWidth={1.8} />
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>

        {footer ? (
          <div className="safe-bottom border-t border-line-soft px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}
