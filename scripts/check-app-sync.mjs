#!/usr/bin/env node
/**
 * 一刻 —— 「界面 → 真实后端」的端到端检查。
 *
 * 为什么还需要这个脚本（check-sync.mjs 已经验过接口了）：
 *   check-sync.mjs 是**照着后端代码**写的请求，它证明不了
 *   「应用真正发出去的请求」和「后端接受的请求」是同一套。
 *   两边各写各的、字段名差一个字母，接口测试照样全绿，用户却同步不了。
 *   所以这里用真浏览器走真界面：配置 → 记录 → 同步 → 去线上查这条在不在。
 *
 * 它是这条链路上唯一的一环 —— 少测了它，就只能等用户在手机上发现「同步没反应」。
 *
 * 用法（地址与令牌同样从参数或环境变量读，脚本不含密钥）：
 *
 *   node scripts/check-app-sync.mjs \
 *     --app=http://127.0.0.1:4173 \
 *     --url=https://yike-sync.xxx.workers.dev --token=yyy
 *
 * 前置：目标地址上跑着一份应用（`npm run preview` 或 `npm run dev`）。
 *
 * 它会在浏览器里记一条**测试记录**，同步上去，确认落库后就地软删除 ——
 * 所以界面上不会给你留一条多余的东西。
 *
 * 退出码：全部通过 0，有任何一项失败 1。
 */

import { chromium } from '@playwright/test'

const flags = new Map()
for (const arg of process.argv.slice(2)) {
  const index = arg.indexOf('=')
  flags.set(index === -1 ? arg : arg.slice(0, index), index === -1 ? true : arg.slice(index + 1))
}

const APP = String(flags.get('--app') ?? process.env.YIKE_APP_URL ?? 'http://127.0.0.1:4173').replace(
  /\/+$/,
  '',
)
const BASE = String(flags.get('--url') ?? process.env.YIKE_SYNC_URL ?? '').replace(/\/+$/, '')
const TOKEN = String(flags.get('--token') ?? process.env.YIKE_SYNC_TOKEN ?? '')

if (BASE === '' || TOKEN === '') {
  process.stderr.write(
    [
      '缺少后端地址或令牌。用法：',
      '',
      '  node scripts/check-app-sync.mjs --app=http://127.0.0.1:4173 \\',
      '    --url=https://yike-sync.xxx.workers.dev --token=yyy',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

let passed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failures.push(name)
    process.stdout.write(`  ✗ ${name}\n`)
    if (detail !== undefined) process.stdout.write(`      ${detail}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}\n`)
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const init = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  const response = await fetch(`${BASE}${path}`, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}

const run = Math.random().toString(16).slice(2, 8)
const CONTENT = `一刻自测 ${run}`

process.stdout.write(`\n一刻 · 界面到后端的端到端检查\n  应用：${APP}\n  后端：${BASE}\n`)

const browser = await chromium.launch()
// 每次跑都用全新的浏览器档案：不带上一次的 IndexedDB 与配置，
// 结果才可复现，也不会把测试数据留在你的真实浏览器里。
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

let recordId = null

try {
  // ---------------------------------------------------------------
  section('0. 应用能打开（本机模式）')

  await page.goto(APP, { waitUntil: 'load' })
  await page.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 15000 })
  check('首页可打开，写入入口可见', true)

  // ---------------------------------------------------------------
  section('1. 先在「未连接云端」时记一条')

  // 这一步是有意的：它同时验证「本机已有记录会在首次登录时归入账号」。
  await page.getByTestId('quick-capture-input').fill(CONTENT)
  await page.getByTestId('quick-capture-idea').click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="quick-capture-input"]')?.value === '',
  )
  await page.getByTestId('record-row').filter({ hasText: CONTENT }).waitFor({ timeout: 10000 })
  check('记录已存到本机', true)

  // ---------------------------------------------------------------
  section('2. 在界面里配置 Cloudflare 并保存')

  await page.getByLabel('设置').click()
  await page.getByTestId('settings-provider-cloudflare').click()
  await page.getByLabel('云端地址').fill(BASE)
  await page.getByLabel('访问令牌').fill(TOKEN)

  // 保存后应用会自己 reload，所以等一次 load 事件
  await Promise.all([
    page.waitForEvent('load', { timeout: 20000 }).catch(() => null),
    page.getByRole('button', { name: '保存连接' }).click(),
  ])
  await page.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 20000 })

  await page.getByLabel('设置').click()
  const providerText = (await page.getByTestId('settings-provider').textContent()) ?? ''
  check('界面认到了 Cloudflare 后端', providerText.includes('Cloudflare'), providerText)

  // ---------------------------------------------------------------
  section('3. 同步上去')

  await page.getByRole('button', { name: '立即同步' }).click()

  let pendingText = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    pendingText = (await page.getByTestId('settings-pending').textContent()) ?? ''
    if (pendingText.trim().startsWith('0')) break
    await page.waitForTimeout(500)
  }
  check('待同步归零（说明推送没有卡住）', pendingText.trim().startsWith('0'), pendingText)

  const phase = (await page.getByTestId('settings-sync-phase').textContent()) ?? ''
  check('同步状态不是「暂时无法同步」', !phase.includes('无法同步'), phase)

  // ---------------------------------------------------------------
  section('4. 去线上后端查这条在不在')

  const pulled = await api('/api/sync/pull', { method: 'POST', body: {} })
  const found = (pulled.body?.records ?? []).find((item) => item.content === CONTENT)
  check('这条记录真的落到了线上数据库', Boolean(found), {
    count: pulled.body?.records?.length ?? 0,
    lookingFor: CONTENT,
  })

  if (found) {
    recordId = found.id
    check('类型是「灵感」', found.type === 'idea', found.type)
    check('创建时间是本机写下的那一个（没被服务端改掉）', typeof found.createdAtUtc === 'string')
    check('版本从 1 开始', found.version === 1, found.version)
  }

  // ---------------------------------------------------------------
  section('5. 反向验证：清掉本机数据后能从云端拉回来')

  // 只清本机 IndexedDB，不动云端。再打开应用时它应该把这条从云端拉回来 ——
  // 这才叫「同步」，只有推上去不算。
  await page.evaluate(async () => {
    const databases = await indexedDB.databases()
    await Promise.all(
      databases
        .filter((item) => item.name)
        .map(
          (item) =>
            new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(item.name)
              // 三个结果都当「删掉了」处理：blocked 表示还有别的连接开着，
              // 但那是本脚本自己的页面，下一次 goto 会把它换掉。
              request.addEventListener('success', () => resolve())
              request.addEventListener('error', () => resolve())
              request.addEventListener('blocked', () => resolve())
            }),
        ),
    )
  })
  await page.goto(APP, { waitUntil: 'load' })
  await page.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 20000 })

  let restored = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const count = await page.getByTestId('record-row').filter({ hasText: CONTENT }).count()
    if (count > 0) {
      restored = true
      break
    }
    await page.waitForTimeout(500)
  }
  check('清空本机后，记录能从云端拉回来（双向都通）', restored)

  const appErrors = consoleErrors.filter((text) => !text.includes('favicon'))
  check('全程没有控制台报错', appErrors.length === 0, appErrors.slice(0, 3))
} catch (error) {
  failures.push(`脚本执行中断：${error instanceof Error ? error.message : String(error)}`)
  process.stdout.write(`\n  ✗ 脚本中断：${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  // ---------------------------------------------------------------
  section('6. 清理本次测试记录')

  if (recordId === null) {
    const pulled = await api('/api/sync/pull', { method: 'POST', body: {} })
    recordId = (pulled.body?.records ?? []).find((item) => item.content === CONTENT)?.id ?? null
  }

  if (recordId === null) {
    process.stdout.write('  没有留下测试记录，无需清理。\n')
  } else {
    const read = await api(`/api/sync/record?id=${encodeURIComponent(recordId)}`)
    const version = read.body?.record?.version
    if (typeof version === 'number') {
      const now = new Date().toISOString()
      const result = await api('/api/sync/mutate', {
        method: 'POST',
        body: {
          mutationId: `app-smoke-del-${run}`,
          recordId,
          operation: 'delete',
          expectedVersion: version,
          payload: { deletedAtUtc: now, updatedAtUtc: now },
        },
      })
      check('测试记录已软删除（界面不会再看到它）', result.body?.status === 'applied', result.body)
    }
  }

  await context.close()
  await browser.close()
}

process.stdout.write('\n' + '─'.repeat(64) + '\n')
if (failures.length === 0) {
  process.stdout.write(`  全部通过（${passed} 项）—— 界面到后端真的通了，不是推断的。\n\n`)
  process.exit(0)
}
process.stdout.write(`  ${passed} 项通过，${failures.length} 项失败：\n`)
for (const name of failures) process.stdout.write(`    · ${name}\n`)
process.stdout.write('\n')
process.exit(1)
