/**
 * 时间系统单元测试（方案 §9 - §14、§25）。
 * 时区必须显式传入，不能依赖运行环境。
 */
import { describe, expect, it } from 'vitest'
import {
  addDays,
  currentMonth,
  dayOfWeek,
  daysBetweenLocalDates,
  daysInMonth,
  deadlineCountdown,
  formatChineseDate,
  formatChineseDateTime,
  formatDoneStamp,
  formatHm,
  formatMonthDay,
  formatRelativeStamp,
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

/**
 * 大事（project）的倒计时。
 *
 * 契约与上面一组一致：**任意输入不许抛异常、不许产出 NaN 天**。
 * 另外这里额外锁死一件事：天数差**必须按日历天算**，不能被时区或夏令时带偏 ——
 * 所以 daysBetweenLocalDates 刻意走 Date.UTC，而不是 `new Date(a) - new Date(b)`。
 */
describe('大事截止日倒计时', () => {
  it('daysBetweenLocalDates 按日历天算，跨月跨年都对', () => {
    expect(daysBetweenLocalDates('2026-09-30', '2026-09-30')).toBe(0)
    expect(daysBetweenLocalDates('2026-09-30', '2026-10-05')).toBe(5)
    expect(daysBetweenLocalDates('2026-09-30', '2026-10-01')).toBe(1)
    expect(daysBetweenLocalDates('2026-10-01', '2026-09-30')).toBe(-1)
    // 跨月（10 月 31 天）
    expect(daysBetweenLocalDates('2026-09-30', '2026-11-01')).toBe(32)
    // 跨年
    expect(daysBetweenLocalDates('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetweenLocalDates('2026-01-01', '2027-01-01')).toBe(365)
    // 闰年 2 月多一天
    expect(daysBetweenLocalDates('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetweenLocalDates('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('daysBetweenLocalDates 对畸形输入返回 null，而不是 NaN 天', () => {
    for (const bad of ['', 'bad', '2026-09', '2026-13-01', '2026-02-30', 'null']) {
      expect(daysBetweenLocalDates(bad, '2026-10-05')).toBeNull()
      expect(daysBetweenLocalDates('2026-09-30', bad)).toBeNull()
    }
    expect(daysBetweenLocalDates('2026-02-29', '2026-03-01')).toBeNull() // 2026 非闰年
  })

  it('已过期 / 今天 / 明天分别给出对应的文案与语气', () => {
    const today = '2026-09-30'
    expect(deadlineCountdown('2026-09-27', today)).toEqual({
      text: '已过期 3 天',
      tone: 'overdue',
      days: -3,
    })
    expect(deadlineCountdown('2026-09-29', today)).toEqual({
      text: '已过期 1 天',
      tone: 'overdue',
      days: -1,
    })
    expect(deadlineCountdown('2026-09-30', today)).toEqual({
      text: '今天到期',
      tone: 'overdue',
      days: 0,
    })
    expect(deadlineCountdown('2026-10-01', today)).toEqual({
      text: '明天到期',
      tone: 'soon',
      days: 1,
    })
  })

  it('三天以内是 soon，超过三天是 calm', () => {
    const today = '2026-09-30'
    expect(deadlineCountdown('2026-10-02', today)).toEqual({
      text: '还剩 2 天',
      tone: 'soon',
      days: 2,
    })
    expect(deadlineCountdown('2026-10-03', today)).toEqual({
      text: '还剩 3 天',
      tone: 'soon',
      days: 3,
    })
    // 第 4 天起退出预警
    expect(deadlineCountdown('2026-10-04', today)).toEqual({
      text: '还剩 4 天',
      tone: 'calm',
      days: 4,
    })
    expect(deadlineCountdown('2026-12-31', today)).toEqual({
      text: '还剩 92 天',
      tone: 'calm',
      days: 92,
    })
  })

  it('倒计时按天算，不受时区影响（同一天不同时区结论一致）', () => {
    // 只传纯日期，压根没有时区参与的余地 —— 换设备不会从「还剩 5 天」漂成「还剩 4 天」
    expect(deadlineCountdown('2026-10-05', '2026-09-30')?.days).toBe(5)
    expect(deadlineCountdown('2026-10-05', '2026-09-30')?.text).toBe('还剩 5 天')
  })

  it('非法截止日返回 null，界面据此不渲染倒计时', () => {
    for (const bad of ['', 'bad', '2026-02-30', '2026-13-01', 'null']) {
      expect(deadlineCountdown(bad, '2026-09-30')).toBeNull()
    }
    expect(deadlineCountdown('2026-10-05', 'bad')).toBeNull()
  })
})

describe('进展记录的时间戳（今天 21:30 / 昨天 09:12）', () => {
  const TZ = 'Asia/Shanghai'

  it('今天 / 昨天 / 前天用相对词，更早的用月日', () => {
    // 上海时间：2026-09-30 21:30 = UTC 13:30
    expect(formatRelativeStamp('2026-09-30T13:30:00.000Z', '2026-09-30', TZ)).toBe('今天 21:30')
    expect(formatRelativeStamp('2026-09-29T01:12:00.000Z', '2026-09-30', TZ)).toBe('昨天 09:12')
    expect(formatRelativeStamp('2026-09-28T01:12:00.000Z', '2026-09-30', TZ)).toBe('前天 09:12')
    expect(formatRelativeStamp('2026-09-20T01:12:00.000Z', '2026-09-30', TZ)).toBe('9月20日 09:12')
  })

  it('★ today 由调用方传入，不自己取当前时间 —— 同一个页面只有一个「今天」', () => {
    // 同一个时刻，站在不同的「今天」看，标签必须不同
    const iso = '2026-09-29T01:12:00.000Z'
    expect(formatRelativeStamp(iso, '2026-09-30', TZ)).toBe('昨天 09:12')
    expect(formatRelativeStamp(iso, '2026-09-29', TZ)).toBe('今天 09:12')
  })

  it('时刻解析不出来时返回空字符串，绝不显示假时间', () => {
    for (const bad of ['', 'bad', 'not-a-date']) {
      expect(formatRelativeStamp(bad, '2026-09-30', TZ)).toBe('')
    }
  })

  it('today 非法时不会把任意日期说成「昨天」', () => {
    // addDays 在 today 非法时原样返回它，所以两个相对判断都不成立
    expect(formatRelativeStamp('2026-09-29T01:12:00.000Z', 'bad', TZ)).toBe('9月29日 09:12')
  })
})
