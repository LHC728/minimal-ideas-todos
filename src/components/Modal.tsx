import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children?: ReactNode
  footer?: ReactNode
  /** 桌面端最大宽度 */
  widthClass?: string
}

/**
 * 手机：底部抽屉；桌面：居中弹层。
 * 详情不是硬要求做三栏布局，数据正确优先于桌面布局炫技（§71）。
 */
export function Modal({ open, onClose, title, children, footer, widthClass = 'md:max-w-lg' }: ModalProps) {
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
        className="animate-fade-in absolute inset-0 bg-[rgba(28,28,30,0.28)]"
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
            <h2 className="text-[15px] font-medium text-ink">{title}</h2>
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
