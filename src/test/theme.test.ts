import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  readStoredMode,
  resolveTheme,
  themeActions,
  themeStore,
  type ThemeMode,
} from '../app/themeStore'
import { DESKTOP_QUERY } from '../hooks/useMediaQuery'

/**
 * 主题这块逻辑很少，但有三处**错了不会报错、只会表现得很怪**的地方，
 * 所以值得钉住：
 *   1. 「跟随系统」与「显式指定」的优先级 —— 反了的话，用户在系统深色下
 *      选「浅色」会没反应，而且他不会想到是优先级的问题。
 *   2. localStorage 抛异常 —— 隐私模式下会抛，主题读不出来**绝不能**把应用带崩。
 *   3. `index.html` 里的防闪脚本与主题模块的存储键必须一致 ——
 *      不一致的话，UI 里切的主题下次打开会丢，且没有任何报错。
 */

function stubSystemDark(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const list = {
      matches: query.includes('prefers-color-scheme: dark') ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }
    return list as unknown as MediaQueryList
  })
}

function isDarkApplied(): boolean {
  return document.documentElement.classList.contains('dark')
}

beforeEach(() => {
  // `themeStore` 是单例、跨用例存活（这正是它在真实应用里的样子），
  // 所以只清 DOM 上的类会让「store 记着的模式」和「DOM 实际的样子」错位，
  // 后面的用例就会因为 `setMode` 的提前返回而看到上一轮的残留。
  // 顺序有讲究：先借 setMode 把两者拉回同一个确定状态，**再**清存储，
  // 这样「没存过」那条用例读到的仍然是空。
  document.documentElement.classList.remove('dark')
  themeActions.setMode('light')
  localStorage.clear()
  themeStore.start()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveTheme：显式选择永远优先于系统', () => {
  it('跟随系统时听系统的', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('用户选了浅色，系统是深色也不跟着变', () => {
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('用户选了深色，系统是浅色也不跟着变', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('readStoredMode：坏值一律退回「跟随系统」', () => {
  it('没存过 → system', () => {
    expect(readStoredMode()).toBe('system')
  })

  it('存过就原样读出来', () => {
    for (const mode of ['system', 'light', 'dark'] as const) {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
      expect(readStoredMode()).toBe(mode)
    }
  })

  it('存了脏值 → 退回 system，而不是崩掉', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'blue')
    expect(readStoredMode()).toBe('system')
  })

  it('localStorage 直接抛错（隐私模式）→ 退回 system', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })
    expect(readStoredMode()).toBe('system')
  })
})

describe('setMode：写进存储、也落到 <html> 上', () => {
  it('选深色 → html.dark 出现，且记住了', () => {
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('选浅色 → html.dark 消失，且记住了', () => {
    themeActions.setMode('dark')
    themeActions.setMode('light')
    expect(isDarkApplied()).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('选「跟随系统」时按系统当前状态落', () => {
    stubSystemDark(true)
    // 先离开 system —— `setMode` 对「选的还是当前这个值」会提前返回，
    // 连选两次 system 只有第一次会真的套用，那样测的就不是这里想测的东西了。
    themeActions.setMode('light')
    themeActions.setMode('system')
    expect(isDarkApplied()).toBe(true)

    stubSystemDark(false)
    themeActions.setMode('light')
    themeActions.setMode('system')
    expect(isDarkApplied()).toBe(false)
  })

  it('重复选当前已生效的值：界面保持正确（提前返回是刻意的，避免无谓重排）', () => {
    themeActions.setMode('dark')
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
  })

  it('存储写不进去也不影响本次会话的显示', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
  })

  it('三个选项的取值与界面按钮一一对应', () => {
    const values: ThemeMode[] = THEME_OPTIONS.map((item) => item.value)
    expect(values).toEqual(['system', 'light', 'dark'])
  })
})

describe('index.html 的防闪脚本与主题模块不许漂移', () => {
  // 这段脚本没法 import 模块（必须内联、必须在首屏之前跑），
  // 所以存储键与取值只能各写一份 —— 那就用这条用例保证两份一样。
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

  it('用的是同一个存储键', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`)
  })

  it('认得同样的三个取值', () => {
    expect(html).toContain("saved === 'light'")
    expect(html).toContain("saved === 'dark'")
    expect(html).toContain("mode === 'system'")
  })

  it('在 <head> 里、且在标题之后立刻执行（否则会闪一帧浅色）', () => {
    const headEnd = html.indexOf('</head>')
    const scriptAt = html.indexOf('prefers-color-scheme: dark')
    expect(scriptAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeLessThan(headEnd)
  })
})

describe('桌面断点：CSS 的 md: 与 JS 的 DESKTOP_QUERY 不许漂移', () => {
  // 同一件事的两半，各写一份所以必须钉住：
  //   CSS 那边管 `md:`（弹层限宽 / 遮罩居中 / Toast 位置 / 底部导航隐藏），
  //   JS 这边管侧栏与右侧详情面板渲不渲染。
  // 两边一旦不一致，就会出现「底部导航还在、中间内容却被它挡住」这种
  // 半吊子形态 —— 不报错，只是某一段宽度区间里的界面没法用。
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  function cssBreakpointPx(): string | null {
    // 只认 px：写 rem 会随浏览器字号漂移，跟 JS 那边的 px 对不上
    return /--breakpoint-md:\s*(\d+)px/.exec(css)?.[1] ?? null
  }

  it('CSS 里确实覆盖了 Tailwind 默认的 768px', () => {
    const px = cssBreakpointPx()
    expect(px).not.toBeNull()
    // 768px 进三列的话，中间内容区只剩 248px（侧栏 200 + 详情 320 = 520 是死的）
    expect(Number(px)).toBeGreaterThan(768)
  })

  it('JS 的断点与 CSS 的 --breakpoint-md 同值', () => {
    const px = cssBreakpointPx()
    expect(DESKTOP_QUERY).toBe(`(min-width: ${px}px)`)
  })
})
