import { useMemo } from 'react'
import { DateGroup } from '../components/DateGroup'
import { RecordRow } from '../components/RecordRow'
import { useIdeas } from '../hooks/useRecords'
import { groupByLocalDate } from '../domain/record'
import { uiActions } from '../app/uiStore'
import { deviceTimeZone } from '../utils/time'

interface PageProps {
  userId: string
}

/**
 * 灵感页（方案 §17）：type = idea 且未删除，按创建时间倒序。
 *
 * 这里类型是统一的，所以不画时间轴（轴没有信息量），
 * 只保留节点作为视觉锚点，行结构与首页保持一致。
 */
export function IdeasPage({ userId }: PageProps) {
  const timezone = deviceTimeZone()
  const ideas = useIdeas(userId)
  const groups = useMemo(() => groupByLocalDate(ideas), [ideas])

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-10">
      <header className="pt-6">
        <h1 className="text-[20px] font-medium leading-[1.2] text-ink">灵感</h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          {ideas.length === 0 ? '还没有灵感' : `记下了 ${ideas.length} 个想法`}
        </p>
      </header>

      <div className="mt-2" data-testid="ideas-list">
        {groups.length === 0 ? (
          <p className="py-14 text-center text-[13px] leading-6 text-ink-soft">
            还没有灵感。
            <br />
            在首页写下第一个想法吧。
          </p>
        ) : (
          groups.map((group) => (
            <DateGroup
              key={group.date}
              date={group.date}
              timezone={timezone}
              count={group.items.length}
            >
              {group.items.map((record) => (
                <RecordRow key={record.id} record={record} onOpen={uiActions.openRecord} />
              ))}
            </DateGroup>
          ))
        )}
      </div>
    </div>
  )
}
