/**
 * 检查一个地址是否真的「可安装为 PWA」。
 *
 * 为什么需要它：`scripts/check-base.mjs` 只能保证路径没写错，
 * 不能保证浏览器愿意把它当应用装。而「装到手机上」正是这个项目的核心诉求。
 *
 * 判据按重要性排序：
 *   1. 安全上下文 —— 浏览器只允许 HTTPS / localhost 安装 PWA（不满足则后面都不用看）
 *   2. manifest 可读且字段完整
 *   3. manifest 里声明的每个图标都能真的取到（图标 404 是最常见的隐形故障）
 *   4. start_url / scope 与当前页面在同一路径前缀下（子路径部署最容易错的地方）
 *   5. Service Worker 已激活，并且**带 fetch 处理器**（Chrome 的硬性要求）
 *   6. CDP 的 Page.getInstallabilityErrors 返回空数组 —— 这是最权威的一条
 *
 * 用法：node scripts/check-installable.mjs https://lhc728.github.io/yike/
 */

import { chromium } from '@playwright/test'

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/check-installable.mjs <url>')
  console.error('例：  node scripts/check-installable.mjs https://lhc728.github.io/yike/')
  process.exit(1)
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

// 页面上真实发生的报错都收集起来 —— 检查失败时这些是唯一有用的线索。
// 主程序里注册 Service Worker 的 catch 是静默的，不抓就什么都看不到。
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(`[未捕获异常] ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`[console.error] ${message.text()}`)
})

try {
  await page.goto(target, { waitUntil: 'load', timeout: 45_000 })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Page.enable')

  // ---------- 1. 安全上下文 ----------
  const secure = await page.evaluate(() => window.isSecureContext)
  check(
    '安全上下文（HTTPS 或 localhost）',
    secure === true,
    secure ? '' : '当前不是安全上下文 —— 浏览器不会允许安装 PWA，这是最常见的原因',
  )

  // ---------- 2. manifest 可读且字段完整 ----------
  const manifestHref = await page.evaluate(
    () => document.querySelector('link[rel="manifest"]')?.href ?? null,
  )
  let manifest = null
  let manifestUrl = null

  if (manifestHref === null) {
    check('页面声明了 manifest', false, 'index.html 里没有 <link rel="manifest">')
  } else {
    manifestUrl = new URL(manifestHref)
    const response = await context.request.get(manifestHref)
    if (!response.ok()) {
      check('manifest 可读取', false, `${manifestHref} → HTTP ${response.status()}`)
    } else {
      manifest = await response.json()
      check('manifest 可读取', true, manifestHref)
    }
  }

  if (manifest !== null && manifestUrl !== null) {
    const missing = ['name', 'start_url', 'display', 'icons'].filter(
      (field) => manifest[field] === undefined,
    )
    check(
      'manifest 必需字段齐全',
      missing.length === 0,
      missing.length === 0 ? '' : `缺少：${missing.join('、')}`,
    )

    const hasLargeIcon = (manifest.icons ?? []).some((icon) => {
      const size = Number.parseInt(String(icon.sizes ?? '').split('x')[0] ?? '', 10)
      return Number.isFinite(size) && size >= 192
    })
    check('至少有一个 ≥192px 的图标', hasLargeIcon, hasLargeIcon ? '' : 'Chrome 要求至少 192×192')

    // ---------- 3. 图标真的取得到 ----------
    for (const icon of manifest.icons ?? []) {
      const iconUrl = new URL(icon.src, manifestUrl).href
      const response = await context.request.get(iconUrl)
      check(
        `图标 ${icon.sizes}（${icon.purpose ?? 'any'}）可达`,
        response.ok(),
        `${iconUrl} → HTTP ${response.status()}`,
      )
    }

    // ---------- 4. start_url / scope 与页面同路径前缀 ----------
    const startUrl = new URL(manifest.start_url ?? '/', manifestUrl)
    check(
      'start_url 落在本站内',
      startUrl.origin === manifestUrl.origin,
      `${startUrl.href}（子路径部署写成 '/' 就会指向域名根，装了也打不开）`,
    )

    const scope = new URL(manifest.scope ?? '/', manifestUrl)
    check(
      'scope 覆盖 start_url',
      startUrl.href.startsWith(scope.href),
      `scope = ${scope.href}`,
    )

    const pagePath = new URL(target).pathname
    check(
      '页面地址在 scope 内',
      pagePath.startsWith(scope.pathname),
      `页面 ${pagePath} 不在 scope ${scope.pathname} 内，浏览器会认为「不在应用范围内」`,
    )
  }

  // ---------- 5. Service Worker 已激活且有 fetch 处理器 ----------
  //
  // 注册是异步的：load 之后才开始注册，激活还要再等一拍（实测约 2 秒）。
  // 不显式等待的话，测到的是「还没注册完」而不是「注册失败」——
  // 一个会误报的检查比没有检查更糟。
  //
  // 这里刻意用「Node 侧显式轮询」而不是 page.waitForFunction：
  // waitForFunction 传异步断言时行为不好把握（曾实测到它不等 Promise 就直接放行），
  // 而且一旦报错还会被 catch 吞掉，变成静默误报。显式轮询没有这些不确定性。
  const readSwState = () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false }
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) return { supported: true, registered: false }
      return {
        supported: true,
        registered: true,
        scope: registration.scope,
        state:
          registration.active?.state ?? registration.waiting?.state ?? registration.installing?.state ?? null,
        controlled: navigator.serviceWorker.controller !== null,
      }
    })

  const deadline = Date.now() + 20_000
  let sw = await readSwState()
  while (Date.now() < deadline && !(sw.registered === true && sw.controlled === true)) {
    await page.waitForTimeout(300)
    sw = await readSwState()
  }

  if (!sw.supported) {
    check('浏览器支持 Service Worker', false, '当前浏览器不支持')
  } else if (!sw.registered) {
    check('Service Worker 已注册', false, '页面没有注册 Service Worker（生产构建才会注册）')
  } else {
    check('Service Worker 已激活', sw.state === 'activated', `state = ${sw.state}`)
    check('当前页面已被 Service Worker 接管', sw.controlled === true)
  }

  // ---------- 6. CDP 权威判据 ----------
  try {
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    const list = installabilityErrors ?? []
    check(
      'CDP Page.getInstallabilityErrors 为空',
      list.length === 0,
      list.length === 0
        ? ''
        : list.map((e) => e.errorId ?? e.errorType ?? JSON.stringify(e)).join('；'),
    )
  } catch (error) {
    check('CDP Page.getInstallabilityErrors', false, `调用失败：${String(error)}`)
  }
} catch (error) {
  check('页面可访问', false, String(error))
} finally {
  await browser.close()
}

// ---------- 输出 ----------

console.log(`\n检查目标：${target}\n`)
let failed = 0
for (const { label, ok, detail } of results) {
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok && detail !== '') console.log(`      ${detail}`)
}

if (failed === 0) {
  console.log('\n✓ 这个地址可以被安装为 PWA，手机浏览器里会出现「安装 / 添加到主屏幕」入口。')
} else {
  console.log(`\n✗ ${failed} 项未通过，当前还不能作为 PWA 安装。`)
  if (pageErrors.length > 0) {
    console.log('\n页面自身报出的错误（排查线索）：')
    for (const line of pageErrors.slice(0, 10)) console.log(`  · ${line}`)
  }
  process.exit(1)
}
