import type { LocalRecord } from '../domain/record'
import { formatHm } from '../utils/time'
import { RecordNode } from './RecordNode'
import { TodoCheckbox } from './TodoCheckbox'

interface RecordRowProps {
  record: LocalRecord
  onOpen: (recordId: string) => void
  onToggle?: (recordId: string) => void
  /** 待办页：左侧是可点击的大勾选框，取代节点 */
  showCheckbox?: boolean
  /** 首页时间线：节点之间画一条 1px 竖轴 */
  showRail?: boolean
  /** 时间线最后一条：不向下延伸竖轴 */
  railEnd?: boolean
  /** 正在播放完成动画 */
  exiting?: boolean
  /** 视觉变淡 */
  dimmed?: boolean
}

/**
 * 一条记录（§17）。
 *
 * 第一行是内容，第二行是时间 —— 时间永远看得见，但永远不抢内容的注意力。
 * 节点用形状表达类型（见 RecordNode）；竖轴只在首页出现：
 * 灵感页 / 日历页里类型是统一的，轴没有信息量。
 */
export function RecordRow({
  record,
  onOpen,
  onToggle,
  showCheckbox = false,
  showRail = false,
  railEnd = false,
  exiting = false,
  dimmed = false,
}: RecordRowProps) {
  const done = record.completedAtUtc !== null
  const faded = dimmed || done

  return (
    <div
      className={`flex items-start ${exiting ? 'animate-row-out' : ''}`}
      data-record-id={record.id}
      data-testid="record-row"
    >
      {showCheckbox ? (
        <TodoCheckbox
          checked={done}
          onToggle={() => onToggle?.(record.id)}
          label={done ? `取消完成：${record.content}` : `完成：${record.content}`}
        />
      ) : (
        <div
          className={`mr-2.5 flex w-[11px] shrink-0 flex-col items-center ${
            showRail ? 'self-stretch' : 'self-start'
          }`}
        >
          <span className="flex h-[22px] shrink-0 items-center">
            <RecordNode type={record.type} completed={done} />
          </span>
          {showRail && !railEnd ? <span className="w-px flex-1 bg-line" aria-hidden /> : null}
        </div>
      )}

      <button
        type="button"
        onClick={() => onOpen(record.id)}
        className={`tap tap-active min-w-0 flex-1 rounded-[8px] text-left ${
          showCheckbox ? 'py-2.5 pr-2' : 'pb-3.5 pr-2'
        }`}
      >
        <span
          className={`block whitespace-pre-wrap break-words text-[15px] leading-[1.45] ${
            faded ? 'text-ink-soft line-through' : 'text-ink'
          }`}
        >
          {record.content || <span className="text-ink-soft">（空）</span>}
        </span>

        <span className="mt-1 block text-[12px] leading-4 text-ink-soft">
          {formatHm(record.createdAtUtc, record.createdTimezone)}
          {done ? ' · 已完成' : ''}
        </span>
      </button>
    </div>
  )
}
