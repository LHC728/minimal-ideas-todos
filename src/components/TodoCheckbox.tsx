import { Check } from 'lucide-react'

interface TodoCheckboxProps {
  checked: boolean
  onToggle: () => void
  label?: string
}

/**
 * 待办勾选框（§19）：必须容易点击。
 *
 * 视觉只有 19px，但触摸区域是 44×44。
 * 未完成 = 雾蓝描边空方框，完成 = 雾蓝实心 + 白勾。
 * 方框形状与时间线上的待办节点一致，保持同一套视觉语言。
 */
export function TodoCheckbox({ checked, onToggle, label }: TodoCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label ?? (checked ? '标记为未完成' : '标记为完成')}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="tap tap-active -ml-[13px] flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-[8px]"
    >
      <span
        className={`flex h-[19px] w-[19px] items-center justify-center rounded-[5px] transition-colors duration-150 ${
          checked ? 'bg-todo' : 'border-[1.5px] border-todo'
        }`}
        aria-hidden
      >
        {checked ? <Check size={13} strokeWidth={3} className="text-white" /> : null}
      </span>
    </button>
  )
}
