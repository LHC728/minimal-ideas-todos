import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from '../app/navItems'
import { useIdeas, useOpenTodos } from '../hooks/useRecords'

interface DesktopSidebarProps {
  userId: string
}

/**
 * 桌面左侧导航。
 *
 * 灵感与待办带数量角标 —— 桌面有空间，顺手回答「我有多少东西」，
 * 不用点进去才知道。首页与日历不带（一个回答时间、一个回答某一天）。
 */
export function DesktopSidebar({ userId }: DesktopSidebarProps) {
  const ideas = useIdeas(userId)
  const todos = useOpenTodos(userId)

  const counts: Record<string, number> = {
    '/ideas': ideas.length,
    '/todos': todos.length,
  }

  return (
    <nav
      className="hidden w-[200px] shrink-0 border-r border-line bg-sunken md:block"
      aria-label="主导航"
      data-testid="main-nav"
    >
      <div className="safe-top sticky top-0 flex h-screen flex-col px-3 py-5">
        <div className="mb-5 px-2 text-[13px] font-medium tracking-wide text-ink">灵感与待办</div>

        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const count = counts[item.to]
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `tap tap-active flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] ${
                      isActive
                        ? 'card-raised font-medium text-ink'
                        : 'text-ink-soft hover:bg-canvas'
                    }`
                  }
                >
                  <Icon size={17} strokeWidth={1.7} />
                  <span className="flex-1">{item.label}</span>
                  {typeof count === 'number' && count > 0 ? (
                    <span className="text-[11px] tabular-nums text-ink-soft">{count}</span>
                  ) : null}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
