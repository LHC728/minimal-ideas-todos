import { clampProgress, PROGRESS_MAX, PROGRESS_MIN } from '../domain/record'
import { deadlineCountdown, formatMonthDay, type DeadlineTone } from '../utils/time'

interface ProgressTrackProps {
  /** 0–100；越界与非法值会被收敛，绝不会渲染出 `width: NaN%` */
  value: number
  /** 轨道高度，默认 6px */
  heightClass?: string
  /**
   * 拖动中：关掉过渡。
   * 开着过渡时填充条会「追」着手指跑，手感发黏 —— 拖动过程中
   * 要的是即时反馈，过渡留给点档位按钮那种跳跃式变化。
   */
  instant?: boolean
  className?: string
  /**
   * 无障碍名称。
   *
   * 传了 → 渲染原生 `<progress>`，读屏软件会朗读「已完成 60%」。
   * 不传 → 渲染成**纯装饰**（`aria-hidden`）。
   *
   * 详情面板里刻意不传：那里外面还叠着一个滑块，滑块自己会朗读
   * 同一个数字。再放一个 progress 只会让读屏软件把 60% 念两遍。
   */
  label?: string
}

/**
 * 大事的进度条（只读）。
 * 编辑用的滑块在详情面板里，这里只负责「一眼看出做到哪了」。
 */
export function ProgressTrack({
  value,
  heightClass = 'h-[6px]',
  instant = false,
  className = '',
  label,
}: ProgressTrackProps) {
  const percent = clampProgress(value) ?? PROGRESS_MIN

  if (label !== undefined) {
    return (
      <progress
        className={`progress-native block w-full rounded-full ${heightClass} ${className}`}
        value={percent}
        max={PROGRESS_MAX}
        aria-label={label}
        data-testid="project-progress"
      />
    )
  }

  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-sunken ${heightClass} ${className}`}
      aria-hidden
    >
      <div
        className={`h-full rounded-full bg-project ${instant ? '' : 'transition-all duration-150'}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/**
 * 倒计时的语气。
 *
 * 刻意不用 idea（赭石）来表示「快到了」—— 那是灵感的语义色，
 * 借来当警告会让颜色失去含义。这里只做两档升级：
 *   平静 → ink-soft，临近 → ink（更实），过期 → danger（红）
 */
const TONE_CLASS: Record<DeadlineTone, string> = {
  calm: 'text-ink-soft',
  soon: 'text-ink',
  overdue: 'text-danger',
}

interface ProjectDeadlineProps {
  deadlineLocalDate: string | null
  /** 由调用方传入「今天」，保证整个页面用的是同一个日期 */
  today: string
  /** 是否在倒计时后面附上具体日期，默认附 */
  withDate?: boolean
}

/** 截止日倒计时：「还剩 12 天 · 10月12日」 */
export function ProjectDeadline({
  deadlineLocalDate,
  today,
  withDate = true,
}: ProjectDeadlineProps) {
  if (deadlineLocalDate === null) return null
  const countdown = deadlineCountdown(deadlineLocalDate, today)
  // 日期解析不出来时干脆不显示 —— 宁可不显示，也不显示一个错的倒计时
  if (!countdown) return null

  const date = formatMonthDay(deadlineLocalDate)

  return (
    <span className={TONE_CLASS[countdown.tone]} data-testid="project-deadline">
      {countdown.text}
      {withDate && date ? ` · ${date}` : ''}
    </span>
  )
}
