/**
 * 时间与时区工具。
 *
 * 核心规则（方案 §10 - §14）：
 *  - created_at 由客户端在“写下的那一刻”捕获，永不改变。
 *  - 归档用 created_local_date，即“用户当时所在时区的日历日”。
 *  - 服务器时间（server_updated_at）只用于同步，绝不覆盖用户记录时间。
 *
 * 所有函数都是纯函数，便于测试。
 *
 * ⚠️ 本文件的总则（2026-10 代码审查后确立，见 docs/代码审查-基线审计报告.md）：
 *
 *   对**任意输入**都必须返回有意义的值，绝不允许
 *     ① 抛出异常，或
 *     ② 返回 NaN / "NaN月NaN日" / {year: null} 这类假值。
 *
 *   给不出正确答案时，明确返回空字符串或 null，由调用方决定如何降级。
 *   理由：时间字段会从云端（created_at_utc / created_local_date）流进来，
 *   一条格式损坏的远端记录不该让整个界面白屏，也不该显示一个看似正常、
 *   实则错误的日期 —— 后者比直接失败更难排查。
 */

const FALLBACK_TZ = 'UTC'

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** YYYY-MM-DD 的严格形状。只做形状校验，语义校验在 parseLocalDate */
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export interface DateParts {
  year: number
  month: number
  day: number
}

/** 规整为 Date；无法解析时返回 null（**不返回 Invalid Date**） */
function toDate(input: string | number | Date): Date | null {
  const date = input instanceof Date ? input : new Date(input)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 严格解析 YYYY-MM-DD。
 *
 * 返回 null 表示输入不是合法日历日：形状不符、月份越界、或该月没有这一天
 * （例如 2026-02-30、2026-13-01）。
 *
 * 这是本文件所有「纯日期字符串」函数的**唯一入口**。历史上它们直接
 * `split('-')` 后 `Number()`，于是：
 *   formatChineseDate("bad")   → "NaN年NaN月NaN日"
 *   monthOf("bad")             → { year: null }
 *   dayOfWeek("2026-13-45")    → 0   ← 静默溢出到 2027-02-14，不报错但日期是错的
 */
export function parseLocalDate(localDate: string): DateParts | null {
  const match = LOCAL_DATE_PATTERN.exec(localDate)
  if (!match) return null
  const [, rawYear, rawMonth, rawDay] = match
  if (rawYear === undefined || rawMonth === undefined || rawDay === undefined) return null
  const year = Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

/** 当前设备的 IANA 时区，例如 Asia/Shanghai */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TZ
  } catch {
    return FALLBACK_TZ
  }
}

/** 时区是否可用（避免个别环境 Intl 不支持某个 tz 导致整站崩） */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function safeTz(tz?: string | null): string {
  if (tz && isValidTimeZone(tz)) return tz
  return deviceTimeZone()
}

/** 当前 UTC 时刻的 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 把任意时间输入规整为 ISO 字符串；无法解析时返回空字符串 */
export function toIso(input: string | number | Date): string {
  const date = toDate(input)
  return date ? date.toISOString() : ''
}

/** 取某个时刻在指定时区下的日历日：YYYY-MM-DD；无法解析时返回空字符串 */
export function localDateOf(input: string | number | Date, tz?: string | null): string {
  const date = toDate(input)
  if (!date) return ''
  const zone = safeTz(tz)
  try {
    // en-CA 输出 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return formatDatePartsFallback(date)
  }
}

/** 取某个时刻在指定时区下的 HH:mm（24 小时制）；无法解析时返回空字符串 */
export function formatHm(input: string | number | Date, tz?: string | null): string {
  const date = toDate(input)
  if (!date) return ''
  const zone = safeTz(tz)
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date)
  } catch {
    return fallbackTimeParts(date)
  }
}

/** 2026年9月30日；输入非法时返回空字符串 */
export function formatChineseDate(localDate: string): string {
  const parts = parseLocalDate(localDate)
  if (!parts) return ''
  return `${parts.year}年${parts.month}月${parts.day}日`
}

/** 2026年9月30日 00:43；无法解析时返回空字符串 */
export function formatChineseDateTime(input: string | number | Date, tz?: string | null): string {
  const date = toDate(input)
  if (!date) return ''
  const zone = safeTz(tz)
  return `${formatChineseDate(localDateOf(date, zone))} ${formatHm(date, zone)}`
}

/** 9月30日；输入非法时返回空字符串 */
export function formatMonthDay(localDate: string): string {
  const parts = parseLocalDate(localDate)
  if (!parts) return ''
  return `${parts.month}月${parts.day}日`
}

/** 9 月 30 日（带空格，用于标题）；输入非法时返回空字符串 */
export function formatMonthDaySpaced(localDate: string): string {
  const parts = parseLocalDate(localDate)
  if (!parts) return ''
  return `${parts.year} 年 ${parts.month} 月 ${parts.day} 日`
}

/** 星期三；输入非法时返回空字符串 */
export function formatWeekday(localDate: string): string {
  const idx = dayOfWeek(localDate)
  if (idx === null) return ''
  return WEEKDAY_NAMES[idx] ?? ''
}

/** 0 = 周日 … 6 = 周六（纯日期运算，不涉及时区）；输入非法时返回 null */
export function dayOfWeek(localDate: string): number | null {
  const parts = parseLocalDate(localDate)
  if (!parts) return null
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

/** 纯日期字符串的加减，返回 YYYY-MM-DD；输入非法时原样返回（不臆造日期） */
export function addDays(localDate: string, days: number): string {
  const parts = parseLocalDate(localDate)
  if (!parts) return localDate
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/**
 * 两个纯日期之间的天数差（`to - from`）。
 *
 * 为什么不用 `new Date(a).getTime() - new Date(b).getTime()`：
 * `new Date('2026-10-05')` 确实按 UTC 解析，但只要输入形状稍微变一下
 * （`'2026-10-05T00:00'`、`'2026/10/05'`）就会按**本地时区**解析，
 * 差值立刻不再是整数天。这里手工拆年月日再走 `Date.UTC`，
 * 时区从头到尾不参与运算。
 *
 * 任一输入非法时返回 null —— 由调用方决定怎么降级。
 * 绝不返回 NaN 或一个看似正常实则错了一天的天数。
 */
export function daysBetweenLocalDates(from: string, to: string): number | null {
  const a = parseLocalDate(from)
  const b = parseLocalDate(to)
  if (!a || !b) return null
  const fromMs = Date.UTC(a.year, a.month - 1, a.day)
  const toMs = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((toMs - fromMs) / 86_400_000)
}

/**
 * 倒计时的语气。
 *   overdue = 已经到点或过点了（红色）
 *   soon    = 三天以内（提前预警，但不是红色）
 *   calm    = 还早
 */
export type DeadlineTone = 'calm' | 'soon' | 'overdue'

export interface DeadlineCountdown {
  /** 「还剩 12 天」「明天到期」「今天到期」「已过期 3 天」 */
  text: string
  tone: DeadlineTone
  /** 距离截止日的天数：正数=还没到，0=今天，负数=已过期 */
  days: number
}

/** 三天以内开始预警（含今天和已过期） */
const SOON_DAYS = 3

/**
 * 大事的截止日倒计时。
 *
 * 以「天」为单位，不是「时:分:秒」—— 大事的粒度就是天，
 * 显示到秒只会每秒重渲染一次而信息量没增加。
 *
 * `today` 由调用方传入而不是在这里取当前时间，是为了让它是纯函数：
 * 可测、可在跨天时由调用方统一刷新。
 */
export function deadlineCountdown(
  deadlineLocalDate: string,
  today: string,
): DeadlineCountdown | null {
  const days = daysBetweenLocalDates(today, deadlineLocalDate)
  if (days === null) return null

  if (days < 0) return { text: `已过期 ${-days} 天`, tone: 'overdue', days }
  if (days === 0) return { text: '今天到期', tone: 'overdue', days }
  if (days === 1) return { text: '明天到期', tone: 'soon', days }
  return { text: `还剩 ${days} 天`, tone: days <= SOON_DAYS ? 'soon' : 'calm', days }
}

/** 当前日历日 */
export function todayLocalDate(tz?: string | null): string {
  return localDateOf(new Date(), tz)
}

/** 今天 / 昨天 / 9月30日；输入非法时返回空字符串 */
export function relativeDayLabel(localDate: string, tz?: string | null): string {
  const today = todayLocalDate(tz)
  if (localDate === today) return '今天'
  if (localDate === addDays(today, -1)) return '昨天'
  if (localDate === addDays(today, -2)) return '前天'
  return formatMonthDay(localDate)
}

/**
 * 「今天 21:30」/「昨天 09:12」/「9月28日 09:10」。
 *
 * `today` 由调用方传入，与 deadlineCountdown 同一套约定 ——
 * 不在函数内部自己取当前时间：既保证它是纯函数（可测），也避免同一个
 * 页面里出现两个不同的「今天」（那种 bug 极难复现）。
 *
 * 时刻无法解析时返回空字符串 —— 宁可不显示，也不显示一个错的时间。
 */
export function formatRelativeStamp(iso: string, today: string, tz?: string | null): string {
  const date = localDateOf(iso, tz)
  if (!date) return ''
  const hm = formatHm(iso, tz)
  // today 非法时 addDays 会原样返回它，于是两个比较都不成立，
  // 直接落到 formatMonthDay —— 不会凭空说成「昨天」。
  const day =
    date === today
      ? '今天'
      : date === addDays(today, -1)
        ? '昨天'
        : date === addDays(today, -2)
          ? '前天'
          : formatMonthDay(date)
  return hm === '' ? day : `${day} ${hm}`
}

/**
 * 「今天 14:32 完成」/「9月28日 09:10 完成」。
 *
 * 待办页「已完成」区专用：那里显示的是**完成时刻**，不是创建时刻，
 * 所以必须把「完成」两个字写出来，否则会被误读成创建时间。
 *
 * 时间无法解析时返回空字符串 —— 宁可不显示，也不显示一个错的完成时间。
 */
export function formatDoneStamp(iso: string, tz?: string | null): string {
  const day = relativeDayLabel(localDateOf(iso, tz), tz)
  const hm = formatHm(iso, tz)
  if (!day && !hm) return ''
  return `${day} ${hm} 完成`
}

/** 两个 ISO 时刻是否同一天（按时区）；任一侧无法解析时返回 false */
export function isSameLocalDate(a: string, b: string, tz?: string | null): boolean {
  const dayA = localDateOf(a, tz)
  const dayB = localDateOf(b, tz)
  if (!dayA || !dayB) return false
  return dayA === dayB
}

/** 两个 ISO 时刻的先后，返回较晚的一个；任一侧无法解析时退化为返回 a */
export function maxIso(a: string, b: string): string {
  const ta = toDate(a)?.getTime()
  const tb = toDate(b)?.getTime()
  if (ta === undefined || tb === undefined) return a
  return ta >= tb ? a : b
}

/** 某个日历日所在月的信息 */
export interface MonthInfo {
  year: number
  month: number // 1-12
}

/** 某个日历日所在月；输入非法时返回 null（调用方必须显式降级） */
export function monthOf(localDate: string): MonthInfo | null {
  const parts = parseLocalDate(localDate)
  if (!parts) return null
  return { year: parts.year, month: parts.month }
}

/**
 * 当前设备时钟所在月。
 *
 * 纯 Date getter，不解析任何字符串，因此**永不失败** ——
 * 专门用作 monthOf() 返回 null 时的降级值。
 */
export function currentMonth(): MonthInfo {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

export function toLocalDateString(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

export function shiftMonth(info: MonthInfo, delta: number): MonthInfo {
  const total = info.year * 12 + (info.month - 1) + delta
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 月历网格：从周一开始，补齐前后空位，固定 6 行 × 7 列。
 * 返回每格为 null（空位）或 YYYY-MM-DD。
 */
export function monthGrid(info: MonthInfo): (string | null)[] {
  const first = toLocalDateString(info.year, info.month, 1)
  // first 由 toLocalDateString 生成，形状必然合法，?? 0 只为满足类型系统
  const lead = ((dayOfWeek(first) ?? 0) + 6) % 7 // 周一为 0
  const total = daysInMonth(info.year, info.month)
  const cells: (string | null)[] = []
  for (let i = 0; i < lead; i += 1) cells.push(null)
  for (let d = 1; d <= total; d += 1) cells.push(toLocalDateString(info.year, info.month, d))
  while (cells.length % 7 !== 0) cells.push(null)
  while (cells.length < 42) cells.push(null)
  return cells
}

export function formatMonthTitle(info: MonthInfo): string {
  return `${info.year}年${info.month}月`
}

// ---- 内部兜底实现（Intl 不可用时） ----
//
// 注意：这两个函数**不依赖 Intl**，全部用 Date 的 UTC getter 手工拼接。
// 上一版它们自己也调用 Intl，导致 catch 分支在 Invalid Date 上抛出同样的
// RangeError —— 兜底形同虚设（见基线审计报告 §3.2）。

function formatDatePartsFallback(date: Date): string {
  return toLocalDateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function fallbackTimeParts(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
