import { useEffect, useState } from 'react'
import { todayLocalDate } from '../utils/time'

/**
 * 当前本地日期，**跨过午夜时自动刷新**。
 *
 * 为什么需要它：大事的倒计时是按「天」算的。页面一直开着不动的话，
 * 昨天写下的「今天到期」到今天早上还会显示「今天到期」—— 而它其实
 * 已经过期了。把 PWA 当常驻应用长期挂着是常态，所以这不是锦上添花。
 *
 * 实现上是算出「到下一个本地午夜还有多久」，睡过去，醒来重算一次。
 * 刻意不用 `setInterval(1000)`：那会每秒重渲染整个首页，
 * 而这里的信息每天才变一次。
 *
 * ⚠️ 午夜是按**设备本地时区**算的（`Date#setHours`），而 `timezone`
 * 参数来自 `deviceTimeZone()`，两者本来就是同一个值。如果将来允许
 * 用户手动指定时区，这里要跟着改成按时区计算。
 */
export function useTodayLocalDate(timezone: string): string {
  const [today, setToday] = useState(() => todayLocalDate(timezone))

  useEffect(() => {
    let timer = 0

    const schedule = (): void => {
      const now = new Date()
      const nextMidnight = new Date(now)
      nextMidnight.setHours(24, 0, 0, 0)
      // 多等 1 秒，避开「刚好卡在午夜边界上、算出来还是昨天」的情况
      const delay = Math.max(1000, nextMidnight.getTime() - now.getTime() + 1000)

      timer = window.setTimeout(() => {
        setToday(todayLocalDate(timezone))
        schedule()
      }, delay)
    }

    schedule()

    // 后台标签页的定时器会被浏览器节流，手机上也可能整个被挂起。
    // 回到前台时补一次，保证不会顶着一个过期一天的日期。
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setToday(todayLocalDate(timezone))
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [timezone])

  return today
}
