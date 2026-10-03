import { useMemo } from 'react'
import { QuickCapture } from '../components/QuickCapture'
import { ProjectModule } from '../components/ProjectModule'
import { DateGroup } from '../components/DateGroup'
import { RecordRow } from '../components/RecordRow'
import { useTimeline } from '../hooks/useRecords'
import { useTodayLocalDate } from '../hooks/useToday'
import { groupByLocalDate } from '../domain/record'
import { uiActions } from '../app/uiStore'
import { deviceTimeZone, formatMonthDay, formatWeekday } from '../utils/time'

interface PageProps {
  userId: string
}

/**
 * 首页（方案 §7、§78）。
 *
 * 首页不是「当前待办列表」，而是「我什么时候记下了什么」的时间线。
 * 已完成 Todo 仍然留在它最初被写下来的时间位置，只是视觉变淡。
 *
 * 视觉上把「时间线」真正做出来：左侧一条 1px 竖轴，
 * 节点用形状表达类型（圆形 = 灵感，方形 = 待办，胶囊 = 大事），
 * 不读文字也能扫出哪条是什么。
 *
 * 三段结构，从上到下是三种不同的时间视角：
 *   输入框      —— 现在要写什么
 *   大事模块    —— 现在该先干哪个（按截止日排，向前看）
 *   时间线      —— 我什么时候记下了什么（按日期归档，向后看）
 */
export function HomePage({ userId }: PageProps) {
  const timezone = deviceTimeZone()
  // 用 hook 而不是直接调 todayLocalDate()：页面长期挂着不动时，
  // 跨过午夜要自己更新，否则大事的倒计时会一直停在昨天。
  const today = useTodayLocalDate(timezone)
  const records = useTimeline(userId)
  const groups = useMemo(() => groupByLocalDate(records), [records])

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-10">
      <header className="pt-6">
        <h1
          className="text-[28px] font-medium leading-[1.15] tracking-[-0.3px] text-ink"
          data-testid="home-date"
        >
          {formatMonthDay(today)}
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">{formatWeekday(today)}</p>
      </header>

      <div className="mt-5">
        <QuickCapture userId={userId} />
      </div>

      <ProjectModule userId={userId} today={today} />

      <div className="mt-1" data-testid="timeline">
        {groups.length === 0 ? (
          <p className="py-14 text-center text-[13px] leading-6 text-ink-soft">
            想到什么，就在上面写下来。
            <br />
            点「记为灵感」或「记为待办」存下来。
          </p>
        ) : (
          groups.map((group) => (
            <DateGroup
              key={group.date}
              date={group.date}
              timezone={timezone}
              count={group.items.length}
            >
              {group.items.map((record, index) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  showRail
                  railEnd={index === group.items.length - 1}
                  onOpen={uiActions.openRecord}
                />
              ))}
            </DateGroup>
          ))
        )}
      </div>
    </div>
  )
}
