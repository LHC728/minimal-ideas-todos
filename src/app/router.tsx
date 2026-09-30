import { HashRouter } from 'react-router-dom'
import { AppShell } from './AppShell'

interface AppRouterProps {
  userId: string
}

/**
 * 路由（方案 §4）。
 *
 * 使用 HashRouter：无论部署在静态主机的根路径还是子路径，
 * 刷新 / 直接打开链接都不会 404 —— 对 Local First 的可用性优先。
 */
export function AppRouter({ userId }: AppRouterProps) {
  return (
    <HashRouter>
      <AppShell userId={userId} />
    </HashRouter>
  )
}
