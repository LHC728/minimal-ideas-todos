import { Undo2 } from 'lucide-react'
import type { LocalRecord } from '../domain/record'
import { formatDoneStamp } from '../utils/time'
import { RecordNode } from './RecordNode'

interface CompletedTodoRowProps {
  record: LocalRecord
  onOpen: (recordId: string) => void
  /** 撤销完成：把这条退回「没做」状态 */
  onUndo: (recordId: string) => void
}

/**
 * 「已完成」区里的一行。
 *
 * 与 RecordRow 的区别是有意的，不是为了标新立异：
 * - 这里是**后悔药**，不是浏览列表，所以唯一的动作是「撤销」，
 *   不放勾选框（勾选框在这里只会让人以为是「再勾一次」）；
 * - 时间显示的是**完成时刻**，所以写成「今天 14:32 完成」而不是裸的 HH:MM；
 * - 撤销按钮是明确带文字的按钮，不是图标 —— 用户就是没看见上一次的撤销机会，
 *   这次不能再靠一个符号去暗示。
 *
 * 触摸目标：撤销按钮高约 44px（行高 56px 减去上下 6px），符合约定。
 */
export function CompletedTodoRow({ record, onOpen, onUndo }: CompletedTodoRowProps) {
  return (
    <div className="flex items-stretch" data-record-id={record.id} data-testid="completed-row">
      <div className="mr-2.5 flex w-[11px] shrink-0 items-start">
        <span className="flex h-[22px] shrink-0 items-center">
          <RecordNode type={record.type} completed />
        </span>
      </div>

      <button
        type="button"
        onClick={() => onOpen(record.id)}
        className="tap tap-active min-w-0 flex-1 rounded-[8px] pb-3.5 pr-2 text-left"
      >
        <span className="block whitespace-pre-wrap break-words text-[15px] leading-[1.45] text-ink-soft line-through">
          {record.content || <span className="text-ink-soft">（空）</span>}
        </span>
        <span className="mt-1 block text-[12px] leading-4 text-ink-soft">
          {record.completedAtUtc ? formatDoneStamp(record.completedAtUtc, record.completedTimezone) : ''}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onUndo(record.id)}
        aria-label={`撤销完成：${record.content}`}
        data-testid="completed-undo"
        className="tap tap-active my-1.5 flex shrink-0 items-center gap-1 rounded-[8px] border border-line px-2.5 text-[13px] font-medium text-idea"
      >
        <Undo2 size={13} strokeWidth={2.1} aria-hidden />
        撤销
      </button>
    </div>
  )
}
