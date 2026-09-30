import { Calendar, Home, Lightbulb, Square, type LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

/**
 * 整个 APP 只有四个一级入口（§4），不要增加第五个。
 *
 * 顺序：「灵感」与「待办」是「记东西 / 做事情」这一对，挨在一起；
 * 日历是「回看某一天」的检索入口，放在最后。
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '首页', icon: Home },
  { to: '/ideas', label: '灵感', icon: Lightbulb },
  { to: '/todos', label: '待办', icon: Square },
  { to: '/calendar', label: '日历', icon: Calendar },
]
