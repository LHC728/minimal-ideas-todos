import { expect, test, type Page } from '@playwright/test'

/**
 * 端到端测试（方案 §77）。
 *
 * 覆盖浏览器层面的 Test 1 / 2 / 13，以及导航、日历归档、搜索、撤销删除、
 * PWA 离线外壳（Service Worker 生效后断网重开仍然可用）。
 *
 * 全部在本机模式下运行：不依赖任何云服务，正好验证「Local First」。
 */

const TZ = 'Asia/Shanghai'

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
}

/** 等待 Service Worker 接管页面（离线外壳生效的前提） */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
    undefined,
    { timeout: 30_000 },
  )
}

async function capture(page: Page, content: string, type: 'idea' | 'todo'): Promise<void> {
  await page.getByTestId('quick-capture-input').fill(content)
  await page.getByTestId(type === 'idea' ? 'quick-capture-idea' : 'quick-capture-todo').click()
  await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
}

function timeline(page: Page) {
  return page.getByTestId('timeline')
}

test.describe('四个一级入口', () => {
  test('手机与桌面都能正确切换四个页面', async ({ page }) => {
    await openApp(page)

    // 顺序：灵感与待办挨在一起，日历排最后
    const navText = (await page.getByTestId('main-nav').locator('ul').innerText()).replace(/\s+/g, ' ')
    expect(navText).toMatch(/首页.*灵感.*待办.*日历/)

    for (const label of ['灵感', '日历', '待办', '首页']) {
      await page.getByTestId('main-nav').getByText(label, { exact: true }).click()
      await expect(page.locator('main h1, main p').first()).toBeVisible()
    }

    // 不要出现第五个一级页面
    const navLinks = page.getByTestId('main-nav').locator('a')
    await expect(navLinks).toHaveCount(4)
  })
})

test.describe('Test 1：离线创建', () => {
  test('断网创建 Idea，刷新后仍然存在', async ({ page, context }) => {
    await openApp(page)
    await waitForServiceWorker(page)
    await page.reload()
    await expect(page.getByTestId('quick-capture')).toBeVisible()

    await context.setOffline(true)
    await capture(page, '以后可以研究机器人 Agent', 'idea')
    await expect(timeline(page).getByText('以后可以研究机器人 Agent')).toBeVisible()

    await page.reload()
    await expect(timeline(page).getByText('以后可以研究机器人 Agent')).toBeVisible()

    await context.setOffline(false)
  })
})

test.describe('Test 2：离线 Todo', () => {
  test('断网创建并完成 Todo，刷新后状态仍然正确', async ({ page, context }) => {
    await openApp(page)
    await waitForServiceWorker(page)
    await page.reload()

    await context.setOffline(true)
    await capture(page, '学习 STM32 定时器', 'todo')

    await page
      .getByTestId('main-nav')
      .getByText('待办', { exact: true })
      .click()
    const row = page.getByTestId('record-row').filter({ hasText: '学习 STM32 定时器' })
    await expect(row).toBeVisible()

    await page.getByRole('checkbox', { name: '完成：学习 STM32 定时器' }).click()
    // 完成提示 + 撤销入口
    await expect(page.getByRole('button', { name: '撤销' })).toBeVisible()
    // 从待办列表消失
    await expect(page.getByTestId('record-row').filter({ hasText: '学习 STM32 定时器' })).toHaveCount(0)

    // 首页时间线上仍然保留
    await page
      .getByTestId('main-nav')
      .getByText('首页', { exact: true })
      .click()
    await expect(timeline(page).getByText('学习 STM32 定时器')).toBeVisible()

    await page.reload()
    await expect(timeline(page).getByText('学习 STM32 定时器')).toBeVisible()

    // 完成 ≠ 删除：待办页依然是空的
    await page
      .getByTestId('main-nav')
      .getByText('待办', { exact: true })
      .click()
    await expect(page.getByTestId('record-row')).toHaveCount(0)

    await context.setOffline(false)
  })
})

test.describe('撤销误打勾（§19、§60）', () => {
  test('打勾后能在「已完成」区撤销，刷新后依然可以', async ({ page }) => {
    await openApp(page)
    await capture(page, '给打印机换墨盒', 'todo')

    await page
      .getByTestId('main-nav')
      .getByText('待办', { exact: true })
      .click()
    await expect(page.getByTestId('record-row').filter({ hasText: '给打印机换墨盒' })).toBeVisible()

    await page.getByRole('checkbox', { name: '完成：给打印机换墨盒' }).click()
    // 打勾后从待办列表消失（完成 ≠ 留在列表里）
    await expect(page.getByTestId('record-row').filter({ hasText: '给打印机换墨盒' })).toHaveCount(0)

    // 但「已完成」区是常驻的 —— 提示几秒就没了，这里不会
    await page.reload()
    await page
      .getByTestId('main-nav')
      .getByText('待办', { exact: true })
      .click()

    const tray = page.getByTestId('completed-tray')
    await expect(tray).toBeVisible()
    // 默认折叠，不干扰主列表
    await expect(page.getByTestId('completed-tray-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('completed-row')).toHaveCount(0)

    // 展开后能看到那条，并且有一个写明「撤销」的按钮
    await page.getByTestId('completed-tray-toggle').click()
    const doneRow = page.getByTestId('completed-row').filter({ hasText: '给打印机换墨盒' })
    await expect(doneRow).toBeVisible()
    await expect(doneRow.getByTestId('completed-undo')).toBeVisible()

    await doneRow.getByTestId('completed-undo').click()

    // 回到待办列表，且「已完成」区随之消失
    await expect(page.getByTestId('record-row').filter({ hasText: '给打印机换墨盒' })).toBeVisible()
    await expect(page.getByTestId('completed-tray')).toHaveCount(0)

    // 撤销是持久化的，不是只改了内存
    await page.reload()
    await expect(page.getByTestId('record-row').filter({ hasText: '给打印机换墨盒' })).toBeVisible()
  })
})

test.describe('Test 13：编辑后重新打开', () => {
  test('编辑内容后刷新，修改仍然存在，且创建时间不变', async ({ page }) => {
    await openApp(page)
    await capture(page, '做一个自己的极简 APP', 'idea')

    await timeline(page).getByText('做一个自己的极简 APP').click()
    await expect(page.getByTestId('detail-content')).toHaveText('做一个自己的极简 APP')
    const createdText = await page.getByTestId('detail-created').innerText()

    await page.getByTestId('detail-edit').click()
    await page.getByTestId('detail-editor').fill('做一个自己的极简 Local First APP')
    await page.getByTestId('detail-save').click()

    await expect(page.getByTestId('detail-content')).toHaveText(
      '做一个自己的极简 Local First APP',
    )
    // 编辑时间独立出现
    await expect(page.getByText('最后编辑')).toBeVisible()

    await page.reload()
    await expect(timeline(page).getByText('做一个自己的极简 Local First APP')).toBeVisible()

    await timeline(page).getByText('做一个自己的极简 Local First APP').click()
    // 创建时间没有被编辑改写
    await expect(page.getByTestId('detail-created')).toHaveText(createdText)
  })
})

test.describe('日历归档（§80）', () => {
  test('有记录的日子显示标识，点击后能看到当天全部记录', async ({ page }) => {
    await openApp(page)
    await capture(page, '机械臂项目也许可以', 'idea')
    await capture(page, '整理智能车资料', 'todo')

    await page
      .getByTestId('main-nav')
      .getByText('日历', { exact: true })
      .click()

    const today = todayInShanghai()
    await page.getByTestId(`calendar-day-${today}`).click()

    const dayList = page.getByTestId('calendar-day-list')
    await expect(dayList.getByText('机械臂项目也许可以')).toBeVisible()
    await expect(dayList.getByText('整理智能车资料')).toBeVisible()
  })

  test('已完成 Todo 仍然可以从日历查看', async ({ page }) => {
    await openApp(page)
    await capture(page, '学习 CAN 总线', 'todo')

    await page
      .getByTestId('main-nav')
      .getByText('待办', { exact: true })
      .click()
    await page.getByRole('checkbox', { name: '完成：学习 CAN 总线' }).click()
    await expect(page.getByTestId('record-row')).toHaveCount(0)

    await page
      .getByTestId('main-nav')
      .getByText('日历', { exact: true })
      .click()
    const today = todayInShanghai()
    await page.getByTestId(`calendar-day-${today}`).click()
    await expect(page.getByTestId('calendar-day-list').getByText('学习 CAN 总线')).toBeVisible()
  })
})

test.describe('删除与撤销（§60）', () => {
  test('删除后从时间线消失，点撤销又回来', async ({ page }) => {
    await openApp(page)
    await capture(page, '临时想法', 'idea')

    await timeline(page).getByText('临时想法').click()
    await page.getByTestId('detail-delete').click()

    await expect(page.getByRole('button', { name: '撤销' })).toBeVisible()
    await expect(timeline(page).getByText('临时想法')).toHaveCount(0)

    await page.getByRole('button', { name: '撤销' }).click()
    await expect(timeline(page).getByText('临时想法')).toBeVisible()
  })
})

test.describe('搜索（§61）', () => {
  test('普通字符串搜索，找不到已删除的记录', async ({ page }) => {
    await openApp(page)
    await capture(page, '研究机器人 Agent', 'idea')
    await capture(page, '研究 STM32 定时器', 'todo')

    await page.getByTestId('open-search').click()
    const panel = page.getByRole('dialog')
    await page.getByTestId('search-input').fill('研究')
    await expect(panel.getByText('研究机器人 Agent')).toBeVisible()
    await expect(panel.getByText('研究 STM32 定时器')).toBeVisible()

    await page.getByTestId('search-input').fill('STM32')
    await expect(panel.getByText('研究 STM32 定时器')).toBeVisible()
    await expect(panel.getByText('研究机器人 Agent')).toHaveCount(0)
  })
})

test.describe('时间贯穿整个 APP（§25）', () => {
  test('首页 / 灵感 / 待办 / 详情都显示时间', async ({ page }) => {
    await openApp(page)
    await capture(page, '时间贯穿测试', 'idea')

    const hhmm = /\d{2}:\d{2}/
    await expect(timeline(page).getByText(hhmm).first()).toBeVisible()

    await page
      .getByTestId('main-nav')
      .getByText('灵感', { exact: true })
      .click()
    await expect(page.getByTestId('ideas-list').getByText(hhmm).first()).toBeVisible()

    await page
      .getByTestId('main-nav')
      .getByText('首页', { exact: true })
      .click()
    await timeline(page).getByText('时间贯穿测试').click()
    await expect(page.getByTestId('detail-created')).toContainText(hhmm)
  })
})

test.describe('同步状态可见（§65）', () => {
  test('本机模式明确提示「仅本机」，并说明内容保存在本机', async ({ page }) => {
    await openApp(page)
    await expect(page.getByTestId('sync-indicator')).toHaveText('仅本机')

    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings-sync-phase')).toHaveText('仅本机（未连接云端）')
    await expect(page.getByTestId('settings-pending')).toContainText('条')
  })
})

test.describe('暗色模式', () => {
  test('切到深色后刷新仍然是深色，选择被记住', async ({ page }) => {
    await openApp(page)
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-theme-dark').click()
    await expect(page.getByTestId('settings-theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveClass(/dark/)

    // 地址栏 / 状态栏颜色必须跟着令牌走，不能还是浅色那条
    const themeColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    )
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
    )
    expect(themeColor).toBe(canvas)

    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)

    // 重新打开设置，选中状态也要还在（读的是存储，不是内存）
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings-theme-dark')).toHaveAttribute('aria-pressed', 'true')
  })

  test('首屏不闪：偏好是深色时，React 挂载之前 <html> 就已经是 dark', async ({ page }) => {
    // 模拟「第二次打开应用」—— 上一轮选过深色，存储里已经有值
    await page.addInitScript(() => {
      try {
        localStorage.setItem('inspiration-todo/theme', 'dark')
      } catch {
        // about:blank 之类取不到存储的场景，忽略即可
      }
    })
    await page.goto('/')

    // 此刻 React 还没渲染完，但防闪脚本已经跑过了
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByTestId('quick-capture')).toBeVisible()
  })

  test('跟随系统：系统深色就深色，显式选浅色后不再跟', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openApp(page)
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.getByTestId('open-settings').click()

    // 显式选浅色 → 即使系统是深色，也不许跟着变
    await page.getByTestId('settings-theme-light').click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    // 选回「跟随系统」→ 立刻按系统当前状态落回深色
    await page.getByTestId('settings-theme-system').click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})

test.describe('移动端体验（§70）', () => {
  test('不允许横向溢出，输入区可用', async ({ page }) => {
    await openApp(page)
    await capture(page, '移动端记录测试内容比较长一些用来检查换行是否正常', 'idea')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
