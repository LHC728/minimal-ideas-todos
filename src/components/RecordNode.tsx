import { Check } from 'lucide-react'
import type { RecordType } from '../domain/record'

interface RecordNodeProps {
  type: RecordType
  completed?: boolean
  /** 时间线上最后一个节点不画向下延伸的竖轴 */
  className?: string
}

/**
 * 记录节点：形状即类型。
 *
 *   实心圆      = 灵感（赭石，发散的想法）
 *   空心圆角方  = 待办（雾蓝，待勾选的行动）
 *   实心方 + 勾 = 待办已完成
 *
 * 形状本身编码了类型，用户不用读文字就能扫出哪条是什么。
 * 导航图标沿用同一套语言（圆形 / 方形），保持认知一致。
 */
export function RecordNode({ type, completed = false, className = '' }: RecordNodeProps) {
  if (type === 'idea') {
    return (
      <span
        className={`block h-[9px] w-[9px] shrink-0 rounded-full bg-idea ${className}`}
        aria-hidden
      />
    )
  }

  if (completed) {
    return (
      <span
        className={`flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-[3px] bg-todo ${className}`}
        aria-hidden
      >
        <Check size={8} strokeWidth={3.2} className="text-white" />
      </span>
    )
  }

  return (
    <span
      className={`block h-[11px] w-[11px] shrink-0 rounded-[3px] border-[1.5px] border-todo ${className}`}
      aria-hidden
    />
  )
}
