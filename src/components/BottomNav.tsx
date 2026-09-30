import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from '../app/navItems'

/**
 * 手机底部导航，兼容 safe-area（§70）。
 *
 * 选中态用赭石色 + 加粗字重，未选中用可读的 ink-soft
 * （不是 ink-faint —— 导航文字必须看得清）。
 */
export function BottomNav() {
  return (
    <nav
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur md:hidden"
      aria-label="主导航"
      data-testid="main-nav"
    >
      <ul className="flex items-stretch">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `tap tap-active flex h-[60px] flex-col items-center justify-center gap-1 text-[11px] ${
                    isActive ? 'font-medium text-idea' : 'text-ink-soft'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={20} strokeWidth={isActive ? 1.9 : 1.6} />
                    <span>{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
