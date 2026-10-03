import { useCallback, useSyncExternalStore } from 'react'

/**
 * 响应式断点。
 *
 * 手机与桌面使用不同的导航结构，这里只渲染当前生效的那一份，
 * 避免 DOM 里同时出现两个同名导航区域。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined') return () => undefined
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  }, [query])

  const getServerSnapshot = useCallback(() => false, [])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * 桌面断点。**必须与 `src/index.css` 里 `@theme` 的 `--breakpoint-md` 同值** ——
 * 那边管 CSS 的 `md:`（弹层限宽 / 遮罩居中 / Toast 位置 / 底部导航隐藏），
 * 这边管 JS 该不该渲染左侧导航与右侧详情面板。同一件事的两半，
 * 漂移了就会出现「底部导航还在、内容却被它挡住」这种半吊子形态。
 * `theme.test.ts` 会把这两个值钉在一起比对。
 *
 * 为什么是 1120px 而不是 Tailwind 默认的 768px：三列时侧栏 200px +
 * 详情面板 320px = 520px 是死的，768px 进三列的话中间只剩 248px。
 */
export const DESKTOP_QUERY = '(min-width: 1120px)'

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}
