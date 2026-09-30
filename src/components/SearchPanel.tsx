import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { uiActions } from '../app/uiStore'
import { useSearchResults } from '../hooks/useRecords'
import { formatHm, relativeDayLabel } from '../utils/time'
import { Modal } from './Modal'

interface SearchPanelProps {
  userId: string | null
  open: boolean
  timezone: string
}

/**
 * 搜索（方案 §61）：普通字符串搜索，不含已删除记录。
 * V1 不做 AI / Embedding / RAG / 语义搜索。
 */
export function SearchPanel({ userId, open, timezone }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const results = useSearchResults(userId, query)

  const groups = useMemo(() => {
    const map = new Map<string, typeof results>()
    for (const record of results) {
      const list = map.get(record.createdLocalDate)
      if (list) list.push(record)
      else map.set(record.createdLocalDate, [record])
    }
    return Array.from(map.entries()).toSorted((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [results])

  if (!open) return null

  return (
    <Modal open onClose={uiActions.closeSearch} title="搜索" widthClass="md:max-w-xl">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2">
        <Search size={16} strokeWidth={1.7} className="shrink-0 text-ink-faint" />
        <input
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索内容"
          aria-label="搜索内容"
          data-testid="search-input"
          className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-soft"
        />
      </div>

      <div className="mt-4">
        {query.trim().length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-soft">输入关键字开始搜索</p>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-soft">没有找到匹配的记录</p>
        ) : (
          groups.map(([date, items]) => (
            <section key={date} className="mb-3">
              <h3 className="pb-1 text-[12.5px] text-ink-soft">{relativeDayLabel(date, timezone)}</h3>
              <ul>
                {items.map((record) => (
                  <li key={record.id}>
                    <button
                      type="button"
                      onClick={() => {
                        uiActions.closeSearch()
                        uiActions.openRecord(record.id)
                      }}
                      className="tap tap-active flex w-full items-start gap-3 rounded-lg px-1 py-2 text-left hover:bg-line-soft"
                    >
                      <span className="mt-[3px] w-[40px] shrink-0 text-[12.5px] tabular-nums text-ink-soft">
                        {formatHm(record.createdAtUtc, record.createdTimezone)}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-ink">
                        {record.content}
                      </span>
                      <span className="mt-[2px] shrink-0 text-[11.5px] text-ink-soft">
                        {record.type === 'todo' ? (record.completedAtUtc ? '已完成' : '待办') : '灵感'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  )
}
