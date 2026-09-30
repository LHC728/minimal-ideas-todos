/**
 * 时间与时区工具。
 *
 * 核心规则（方案 §10 - §14）：
 *  - created_at 由客户端在“写下的那一刻”捕获，永不改变。
 *  - 归档用 created_local_date，即“用户当时所在时区的日历日”。
 *  - 服务器时间（server_updated_at）只用于同步，绝不覆盖用户记录时间。
 *
 * 所有函数都是纯函数，便于测试。
 */

const FALLBACK_TZ = 'UTC'

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

/** 把任意时间输入规整为 ISO 字符串 */
export function toIso(input: string | number | Date): string {
  return new Date(input).toISOString()
}

/** 取某个时刻在指定时区下的日历日：YYYY-MM-DD */
export function localDateOf(input: string | number | Date, tz?: string | null): string {
  const date = input instanceof Date ? input : new Date(input)
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
    return formatDatePartsFallback(date, 'UTC')
  }
}

/** 取某个时刻在指定时区下的 HH:mm（24 小时制） */
export function formatHm(input: string | number | Date, tz?: string | null): string {
  const date = input instanceof Date ? input : new Date(input)
  const zone = safeTz(tz)
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date)
  } catch {
    return fallbackTimeParts(date, 'UTC')
  }
}

/** 2026年9月30日 */
export function formatChineseDate(localDate: string): string {
  const [y, m, d] = localDate.split('-')
  return `${Number(y)}年${Number(m)}月${Number(d)}日`
}

/** 2026年9月30日 00:43 */
export function formatChineseDateTime(input: string | number | Date, tz?: string | null): string {
  const date = input instanceof Date ? input : new Date(input)
  const zone = safeTz(tz)
  return `${formatChineseDate(localDateOf(date, zone))} ${formatHm(date, zone)}`
}

/** 9月30日 */
export function formatMonthDay(localDate: string): string {
  const [, m, d] = localDate.split('-')
  return `${Number(m)}月${Number(d)}日`
}

/** 9 月 30 日（带空格，用于标题） */
export function formatMonthDaySpaced(localDate: string): string {
  const [y, m, d] = localDate.split('-')
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`
}

/** 星期三 */
export function formatWeekday(localDate: string): string {
  const names = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const idx = dayOfWeek(localDate)
  return names[idx] ?? ''
}

/** 0 = 周日 … 6 = 周六（纯日期运算，不涉及时区） */
export function dayOfWeek(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 纯日期字符串的加减，返回 YYYY-MM-DD */
export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/** 当前日历日 */
export function todayLocalDate(tz?: string | null): string {
  return localDateOf(new Date(), tz)
}

/** 今天 / 昨天 / 9月30日 */
export function relativeDayLabel(localDate: string, tz?: string | null): string {
  const today = todayLocalDate(tz)
  if (localDate === today) return '今天'
  if (localDate === addDays(today, -1)) return '昨天'
  if (localDate === addDays(today, -2)) return '前天'
  return formatMonthDay(localDate)
}

/**
 * 「今天 14:32 完成」/「9月28日 09:10 完成」。
 *
 * 待办页「已完成」区专用：那里显示的是**完成时刻**，不是创建时刻，
 * 所以必须把「完成」两个字写出来，否则会被误读成创建时间。
 */
export function formatDoneStamp(iso: string, tz?: string | null): string {
  return `${relativeDayLabel(localDateOf(iso, tz), tz)} ${formatHm(iso, tz)} 完成`
}

/** 两个 ISO 时刻是否同一天（按时区） */
export function isSameLocalDate(a: string, b: string, tz?: string | null): boolean {
  return localDateOf(a, tz) === localDateOf(b, tz)
}

/** 两个 ISO 时刻的先后，返回较晚的一个 */
export function maxIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

/** 某个日历日所在月的信息 */
export interface MonthInfo {
  year: number
  month: number // 1-12
}

export function monthOf(localDate: string): MonthInfo {
  const [y, m] = localDate.split('-').map(Number)
  return { year: y, month: m }
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
  const lead = (dayOfWeek(first) + 6) % 7 // 周一为 0
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

function formatDatePartsFallback(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date)
}

function fallbackTimeParts(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}
