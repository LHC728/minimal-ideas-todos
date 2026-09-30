/**
 * 时区工具：集中处理“捕获时刻 + 时区 + 归档日”三件套。
 */
import { deviceTimeZone, isValidTimeZone, localDateOf, nowIso } from './time'

export interface CapturedTime {
  /** UTC ISO 时刻 */
  utc: string
  /** 写入时用户所在时区 */
  timezone: string
  /** 写入时用户时区下的日历日 YYYY-MM-DD */
  localDate: string
}

/** 捕获“此刻”，同时锁定时区与归档日 */
export function captureNow(utc: string = nowIso(), tz?: string | null): CapturedTime {
  const timezone = tz && isValidTimeZone(tz) ? tz : deviceTimeZone()
  return {
    utc,
    timezone,
    localDate: localDateOf(utc, timezone),
  }
}

/** 给定一个 UTC 时刻和它当时的时区，补出归档日 */
export function capturedFrom(utc: string, timezone?: string | null): CapturedTime {
  const tz = timezone && isValidTimeZone(timezone) ? timezone : deviceTimeZone()
  return { utc, timezone: tz, localDate: localDateOf(utc, tz) }
}

export { deviceTimeZone, isValidTimeZone }
