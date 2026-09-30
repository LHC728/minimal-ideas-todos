import type { ReactNode } from 'react'
import { relativeDayLabel } from '../utils/time'

interface DateGroupProps {
  date: string
  timezone: string
  count?: number
  children: ReactNode
}

/**
 * 日期分组（§25）。
 *
 * 「今天 / 昨天 / 9月28日」+ 条数，右侧接一条延伸的分隔线，
 * 让分组在视觉上有明确的起点。吸顶位置避让 APP 顶栏与刘海。
 */
export function DateGroup({ date, timezone, count, children }: DateGroupProps) {
  return (
    <section>
      <h3 className="sticky top-[calc(48px+env(safe-area-inset-top))] z-10 -mx-4 flex items-center gap-2 bg-canvas px-4 pb-3 pt-5">
        <span className="text-[12px] font-medium text-ink-soft">
          {relativeDayLabel(date, timezone)}
        </span>
        {typeof count === 'number' ? (
          <span className="text-[12px] text-ink-soft">{count} 条</span>
        ) : null}
        <span className="h-px flex-1 bg-line" aria-hidden />
      </h3>
      <div>{children}</div>
    </section>
  )
}
