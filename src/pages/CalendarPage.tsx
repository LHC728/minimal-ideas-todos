import { useMemo, useState } from 'react'
import { MonthCalendar } from '../components/MonthCalendar'
import { RecordRow } from '../components/RecordRow'
import { useRecordDates, useRecordsOnDate } from '../hooks/useRecords'
import { uiActions, useUi } from '../app/uiStore'
import {
  currentMonth,
  deviceTimeZone,
  formatMonthDay,
  formatWeekday,
  monthOf,
  shiftMonth,
  todayLocalDate,
  type MonthInfo,
} from '../utils/time'

interface PageProps {
  userId: string
}

/**
 * 日历（方案 §23、§24、§80）。
 *
 * 日历回答的是「我在某一天想到了什么、记下了什么」，
 * 而不是「某一天计划做什么」—— 一切按 created_local_date 归档。
 */
export function CalendarPage({ userId }: PageProps) {
  const timezone = deviceTimeZone()
  const today = todayLocalDate(timezone)
  // today 来自 todayLocalDate()，必然合法；currentMonth() 是类型系统要求的降级值
  const [info, setInfo] = useState<MonthInfo>(() => monthOf(today) ?? currentMonth())

  const ui = useUi()
  const selectedDate = ui.selectedDate ?? today

  const marked = useRecordDates(userId)
  const records = useRecordsOnDate(userId, selectedDate)

  const title = useMemo(
    () => `${formatMonthDay(selectedDate)} ${formatWeekday(selectedDate)}`,
    [selectedDate],
  )

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-10">
      <header className="pt-6">
        <h1 className="text-[20px] font-medium leading-[1.2] text-ink">日历</h1>
        <p className="mt-1 text-[12px] text-ink-soft">我在哪一天记下了什么</p>
      </header>

      <div className="mt-4">
        <MonthCalendar
          info={info}
          selectedDate={selectedDate}
          markedDates={marked}
          timezone={timezone}
          onSelect={(date) => uiActions.selectDate(date)}
          onShiftMonth={(delta) => setInfo((prev) => shiftMonth(prev, delta))}
          onToday={() => {
            setInfo(monthOf(today) ?? currentMonth())
            uiActions.selectDate(today)
          }}
        />
      </div>

      <div className="mt-7" data-testid="calendar-day-list">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] font-medium text-ink-soft">{title}</h2>
          {records.length > 0 ? (
            <span className="text-[12px] text-ink-soft">{records.length} 条</span>
          ) : null}
        </div>

        {records.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-ink-soft">这一天没有记录。</p>
        ) : (
          <div className="mt-2">
            {records.map((record) => (
              <RecordRow key={record.id} record={record} onOpen={uiActions.openRecord} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
