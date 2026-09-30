/**
 * 主题：浅色 / 深色 / 跟随系统。
 *
 * 三态而不是两态，是因为「跟随系统」才是大多数人的默认期望 ——
 * 手机上开了夜间模式，应用却还是白的，那才是 bug。
 * 但也要允许用户显式指定：有人系统是深色，却希望这个「本子」保持纸的感觉。
 *
 * 实现上只有一件事：给 `<html>` 加或去掉 `dark` 类。
 * 所有颜色都由 CSS 令牌驱动（见 `src/index.css` 的 `html.dark`），
 * 组件里没有任何一处判断当前主题 —— 那正是这套令牌存在的意义。
 *
 * ⚠️ `THEME_STORAGE_KEY` 是**存储键**，不是显示名。
 * 改它等于让所有已设置过主题的用户回到默认值。
 * 它同时也是 `index.html` 里那段防闪脚本要读的键，两边必须一致
 * （`src/test/theme.test.ts` 会逐字比对，防止悄悄漂移）。
 */
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'inspiration-todo/theme'

export const THEME_OPTIONS: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const DARK_QUERY = '(prefers-color-scheme: dark)'

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * 读本机保存的偏好。
 *
 * 任何异常情况都退回 `system`，绝不抛错：隐私模式下 `localStorage`
 * 会直接抛异常，而主题读不出来这件事**不能**把整个应用带崩。
 */
export function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/** 纯函数：偏好 + 系统当前状态 → 实际该用哪个主题。 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

/** 当前系统是否偏好深色。名字刻意与 `resolveTheme` 的参数区分开，避免遮蔽。 */
function detectSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(DARK_QUERY).matches
}

/**
 * 把主题落到 DOM 上。
 *
 * 顺带更新 `theme-color`：手机浏览器的地址栏 / 状态栏颜色由它决定，
 * 不跟着换的话，深色界面上会顶着一条浅色的横条。
 * 颜色**从 CSS 令牌里读**，不在这里再写一遍十六进制 —— 写两遍必然漂移。
 */
function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return

  document.documentElement.classList.toggle('dark', resolved === 'dark')

  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const canvas = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-canvas')
    .trim()
  if (canvas !== '') meta.setAttribute('content', canvas)
}

class ThemeStore {
  private listeners = new Set<() => void>()
  private mode: ThemeMode = 'system'
  private media: MediaQueryList | null = null
  private started = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 返回字符串（不是对象），所以不需要额外的缓存层 */
  getSnapshot = (): ThemeMode => this.mode

  /**
   * 启动：读本机偏好、套用、并开始跟随系统。
   *
   * 首屏那一次套用其实已经由 `index.html` 里的内联脚本做过了
   * （否则会先闪一帧浅色）。这里负责的是**后续**：
   * 同步 store 里的值、修正 theme-color、以及系统主题变化时跟着变。
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.mode = readStoredMode()
    this.applyCurrent()

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    this.media = window.matchMedia(DARK_QUERY)
    this.media.addEventListener('change', this.onSystemChange)
  }

  private onSystemChange = (): void => {
    // 只有「跟随系统」才需要动 —— 用户显式选了浅色/深色时，
    // 系统怎么变都不该改他的选择。
    if (this.mode === 'system') this.applyCurrent()
  }

  setMode(mode: ThemeMode): void {
    if (mode === this.mode) return
    this.mode = mode
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      // 存不下（隐私模式）就只在本次会话生效 —— 不影响使用，只是下次要重选
    }
    this.applyCurrent()
    for (const listener of this.listeners) listener()
  }

  private applyCurrent(): void {
    applyTheme(resolveTheme(this.mode, detectSystemPrefersDark()))
  }
}

export const themeStore = new ThemeStore()

export const themeActions = {
  setMode(mode: ThemeMode): void {
    themeStore.setMode(mode)
  },
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot)
}
