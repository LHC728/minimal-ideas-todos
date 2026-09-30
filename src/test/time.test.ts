/**
 * 时间系统单元测试（方案 §9 - §14、§25）。
 * 时区必须显式传入，不能依赖运行环境。
 */
import { describe, expect, it } from 'vitest'
import {
  addDays,
  currentMonth,
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
  parseLocalDate,
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
    if (!info) throw new Error('unreachable')

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

/**
 * 非法输入的健壮性（基线审计 §3.1、§3.2）。
 *
 * 这两组用例锁死的是「不许产出假值」这个契约：
 *   - 不许抛异常（会让 React 渲染直接白屏）
 *   - 不许返回 NaN / "NaN月NaN日" / {year: null}（看起来正常，其实是错的）
 */
describe('非法输入不得产出假值', () => {
  /** 非法的「纯日期字符串」——parseLocalDate 一律拒绝 */
  const badDateStrings = [
    '',
    'bad',
    '2026-09',
    '2026-13-01', // 月份越界
    '2026-13-45', // 曾经静默溢出成 2027-02-14
    '2026-02-30', // 2 月没有 30 日
    '2026-09-31', // 9 月没有 31 日
    '2026-02-29', // 2026 不是闰年
    'null',
  ]

  /** 非法的「时刻」——JS 的 Date 构造函数一律解析为 Invalid Date */
  const badInstants = ['', 'bad', 'null', '2026-13-01', '2026-13-45']

  it('parseLocalDate 只接受真实存在的日历日', () => {
    expect(parseLocalDate('2026-09-30')).toEqual({ year: 2026, month: 9, day: 30 })
    expect(parseLocalDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    for (const input of badDateStrings) {
      expect(parseLocalDate(input)).toBeNull()
    }
  })

  it('格式化函数返回空字符串，而不是 "NaN月NaN日"', () => {
    for (const input of badDateStrings) {
      expect(formatChineseDate(input)).toBe('')
      expect(formatMonthDay(input)).toBe('')
      expect(formatWeekday(input)).toBe('')
    }
  })

  it('计算函数返回 null / 原值，而不是静默溢出成另一个日期', () => {
    for (const input of badDateStrings) {
      expect(dayOfWeek(input)).toBeNull()
      expect(monthOf(input)).toBeNull()
      expect(addDays(input, 1)).toBe(input)
    }
  })

  it('localDateOf / formatHm 对非法时刻返回空串而不是抛异常', () => {
    // 曾经的「假兜底」：catch 分支自己也格式化 Invalid Date，
    // 于是抛出同样的 RangeError —— 兜底形同虚设，最终整页白屏。
    for (const input of badInstants) {
      expect(() => localDateOf(input, 'Asia/Shanghai')).not.toThrow()
      expect(() => formatHm(input, 'Asia/Shanghai')).not.toThrow()
      expect(localDateOf(input, 'Asia/Shanghai')).toBe('')
      expect(formatHm(input, 'Asia/Shanghai')).toBe('')
    }
    expect(() => localDateOf(NaN)).not.toThrow()
    expect(() => localDateOf(undefined as unknown as string)).not.toThrow()
  })

  it('组合函数对非法输入返回空串，不留孤零零的「完成」二字', () => {
    for (const input of badInstants) {
      expect(formatChineseDateTime(input, 'Asia/Shanghai')).toBe('')
      expect(formatDoneStamp(input, 'Asia/Shanghai')).toBe('')
    }
  })

  it('currentMonth 永不失败，可作为 monthOf 的降级值', () => {
    const month = currentMonth()
    expect(Number.isInteger(month.year)).toBe(true)
    expect(month.month).toBeGreaterThanOrEqual(1)
    expect(month.month).toBeLessThanOrEqual(12)
  })
})
