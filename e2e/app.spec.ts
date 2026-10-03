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

/** 上海时区下「今天 ± N 天」的纯日期，用来测大事倒计时 */
function daysFromTodayInShanghai(days: number): string {
  const base = new Date(`${todayInShanghai()}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
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

/**
 * 大事（目前在做的大事）—— 首页的第三个功能。
 *
 * 它是**独立一栏**，插在输入框与时间线之间，和「记为灵感 / 记为待办」
 * 那种快车道刻意分开：大事要多填一个截止日，塞进快车道会拖慢最常用的路径。
 */
test.describe('大事：目前在做的大事', () => {
  test('新建带截止日的大事 → 模块与时间线都出现 → 详情改进度 → 刷新仍在', async ({ page }) => {
    await openApp(page)

    const module = page.getByTestId('project-module')
    await expect(module).toBeVisible()
    await expect(module.getByText('目前在做的大事')).toBeVisible()
    await expect(module.getByText('还没有大事')).toBeVisible()

    // 截止日设成 5 天后 → 模块里应显示「还剩 5 天」
    await page.getByTestId('project-add').click()
    await page.getByTestId('project-create-input').fill('把机械臂调通')
    await page.getByTestId('project-create-deadline').fill(daysFromTodayInShanghai(5))
    await page.getByTestId('project-create-save').click()

    const row = page.getByTestId('project-row').filter({ hasText: '把机械臂调通' })
    await expect(row).toBeVisible()
    await expect(row.getByText('0%')).toBeVisible()
    await expect(row.getByTestId('project-deadline')).toHaveText(/还剩 5 天/)
    await expect(module.getByText('1 件')).toBeVisible()

    // 时间线里也出现（用户拍板：出现，但只显示内容 + 时间）
    await expect(timeline(page).getByText('把机械臂调通')).toBeVisible()

    // 点开详情 → 用档位按钮把进度推到 50%
    await row.click()
    const editor = page.getByTestId('project-editor')
    await expect(editor).toBeVisible()
    await expect(page.getByTestId('project-percent')).toHaveText('0%')

    await page.getByTestId('project-preset-50').click()
    await expect(page.getByTestId('project-percent')).toHaveText('50%')

    // 刷新后进度落库了，模块上也是 50%
    await page.reload()
    const afterReload = page.getByTestId('project-row').filter({ hasText: '把机械臂调通' })
    await expect(afterReload).toBeVisible()
    await expect(afterReload.getByText('50%')).toBeVisible()

    // 推到 100% → 从「在做的大事」里消失，但时间线里还在（没丢）
    await afterReload.click()
    await page.getByTestId('project-finish').click()
    await expect(page.getByTestId('project-percent')).toHaveText('100%')
    await expect(page.getByTestId('project-editor').getByText('已完成')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('project-row').filter({ hasText: '把机械臂调通' })).toHaveCount(0)
    await expect(page.getByTestId('project-module').getByText('还没有大事')).toBeVisible()
    await expect(timeline(page).getByText('把机械臂调通')).toBeVisible()
  })

  test('先记下来不设截止日 → 详情里补上后出现倒计时，过期会红', async ({ page }) => {
    await openApp(page)

    await page.getByTestId('project-add').click()
    await page.getByTestId('project-create-input').fill('写完论文初稿')
    await page.getByTestId('project-create-save').click()

    const row = page.getByTestId('project-row').filter({ hasText: '写完论文初稿' })
    await expect(row).toBeVisible()
    // 没设截止日 → 模块里不显示倒计时
    await expect(row.getByTestId('project-deadline')).toHaveCount(0)

    await row.click()
    const editor = page.getByTestId('project-editor')
    await expect(editor.getByText('还没设截止日')).toBeVisible()

    // 补一个 3 天后的截止日（详情里的倒计时不附具体日期，模块里的会附）
    await page.getByTestId('project-deadline-input').fill(daysFromTodayInShanghai(3))
    await expect(editor.getByTestId('project-deadline')).toHaveText('还剩 3 天')

    // 改成已经过期的日子 → 显示「已过期」，且用的是红色（danger）
    await page.getByTestId('project-deadline-input').fill(daysFromTodayInShanghai(-3))
    const countdown = editor.getByTestId('project-deadline')
    await expect(countdown).toHaveText('已过期 3 天')
    const color = await countdown.evaluate((el) => getComputedStyle(el).color)
    const danger = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim(),
    )
    expect(danger).not.toBe('')
    // 把令牌值（#rrggbb）转成 rgb 再比，避免格式差异
    const probe = await page.evaluate((hex) => {
      const div = document.createElement('div')
      div.style.color = hex
      document.body.append(div)
      const value = getComputedStyle(div).color
      div.remove()
      return value
    }, danger)
    expect(color).toBe(probe)

    // 清除后回到「还没设截止日」
    await page.getByTestId('project-deadline-clear').click()
    await expect(editor.getByText('还没设截止日')).toBeVisible()
  })
})
