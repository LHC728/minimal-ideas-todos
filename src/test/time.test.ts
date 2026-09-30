/**
 * 时间系统单元测试（方案 §9 - §14、§25）。
 * 时区必须显式传入，不能依赖运行环境。
 */
import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayOfWeek,
  daysInMonth,
  formatChineseDate,
  formatChineseDateTime,
  formatDoneStamp,
  formatHm,
  formatMonthDay,
  formatWeekday,
  localDateOf,
  monthGrid,
  monthOf,
  relativeDayLabel,
  shiftMonth,
  todayLocalDate,
} from '../utils/time'
import { captureNow, capturedFrom } from '../utils/timezone'

describe('created_local_date 由用户时区决定', () => {
  it('上海 00:43 属于当天，而不是 UTC 的前一天', () => {
    const utc = '2026-09-29T16:43:00.000Z'
    expect(localDateOf(utc, 'Asia/Shanghai')).toBe('2026-09-30')
    expect(localDateOf(utc, 'UTC')).toBe('2026-09-29')
  })

  it('换时区不会让已经归档的日期漂移（归档日固化在写入时）', () => {
    const captured = captureNow('2026-09-29T16:43:00.000Z', 'Asia/Shanghai')
    expect(captured.localDate).toBe('2026-09-30')
    expect(captured.timezone).toBe('Asia/Shanghai')

    // 用户之后跑到纽约，历史记录的归档日不变（它是存下来的字段）
    expect(localDateOf(captured.utc, 'America/New_York')).toBe('2026-09-29')
    expect(captured.localDate).toBe('2026-09-30')
  })

  it('capturedFrom 用当时的时区补出归档日', () => {
    expect(capturedFrom('2026-09-29T16:43:00.000Z', 'Asia/Shanghai').localDate).toBe('2026-09-30')
  })

  it('非法时区回退到设备时区而不是崩溃', () => {
    expect(() => captureNow('2026-09-29T16:43:00.000Z', 'Not/AZone')).not.toThrow()
    expect(capturedFrom('2026-09-29T16:43:00.000Z', 'Not/AZone').timezone).toBeTruthy()
  })
})

describe('展示格式', () => {
  it('HH:mm 使用 24 小时制，零点显示 00:00', () => {
    expect(formatHm('2026-09-29T16:43:00.000Z', 'Asia/Shanghai')).toBe('00:43')
    expect(formatHm('2026-09-29T16:00:00.000Z', 'Asia/Shanghai')).toBe('00:00')
    expect(formatHm('2026-09-29T23:59:00.000Z', 'Asia/Shanghai')).toBe('07:59')
  })

  it('详情使用 YYYY年M月D日 HH:mm', () => {
    expect(formatChineseDateTime('2026-09-29T16:43:00.000Z', 'Asia/Shanghai')).toBe(
      '2026年9月30日 00:43',
    )
  })

  it('分组标题是 今天 / 昨天 / M月D日', () => {
    const today = todayLocalDate('Asia/Shanghai')
    expect(relativeDayLabel(today, 'Asia/Shanghai')).toBe('今天')
    expect(relativeDayLabel(addDays(today, -1), 'Asia/Shanghai')).toBe('昨天')
    expect(relativeDayLabel(addDays(today, -2), 'Asia/Shanghai')).toBe('前天')
    expect(relativeDayLabel('2020-01-05', 'Asia/Shanghai')).toBe('1月5日')
  })

  it('「已完成」区显示的是完成时刻，必须带「完成」二字', () => {
    const today = todayLocalDate('Asia/Shanghai')
    expect(formatDoneStamp(`${today}T06:32:00.000Z`, 'Asia/Shanghai')).toBe('今天 14:32 完成')
    expect(formatDoneStamp('2020-01-05T06:32:00.000Z', 'Asia/Shanghai')).toBe('1月5日 14:32 完成')
  })

  it('中文日期与星期', () => {
    expect(formatChineseDate('2026-09-30')).toBe('2026年9月30日')
    expect(formatMonthDay('2026-09-30')).toBe('9月30日')
    expect(formatWeekday('2026-09-30')).toBe('星期三')
    expect(dayOfWeek('2026-09-30')).toBe(3)
  })
})

describe('月历网格', () => {
  it('2026 年 9 月 1 日是星期二，网格从周一开始补齐', () => {
    const info = monthOf('2026-09-30')
    expect(info).toEqual({ year: 2026, month: 9 })

    const cells = monthGrid(info)
    expect(cells).toHaveLength(42)
    // 周一位在索引 0，9 月 1 日是周二 → 第一个格子为空
    expect(cells[0]).toBeNull()
    expect(cells[1]).toBe('2026-09-01')
    expect(cells[1 + 29]).toBe('2026-09-30')
  })

  it('天数与跨年翻月', () => {
    expect(daysInMonth(2026, 9)).toBe(30)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
  })
})
