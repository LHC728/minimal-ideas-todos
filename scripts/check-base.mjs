/**
 * 校验构建产物的部署基路径是否正确。
 *
 * 背景：GitHub Pages 把站点放在 https://<user>.github.io/<repo>/，是**子路径**。
 * 任何写成绝对路径 '/' 的资源引用都会指向域名根，直接 404 —— 而本机
 * 用 `npm run preview` 时因为 base 恰好也是 '/'，永远不会暴露这个问题。
 * 这正是「本地全绿、部署即坏」的经典坑，所以给它一个门禁。
 *
 * 校验两件事：
 *   1) dist 里每个绝对路径都必须带 base 前缀；
 *   2) 去掉 base 之后，对应文件必须真的存在于 dist/。
 *
 * 第 2 条是关键：它同时能抓出「漏了 base」和「base 写错了」两种情况。
 *
 * 用法：node scripts/check-base.mjs /yike/
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, '..', 'dist')

/** 把任意写法归一成「前有斜杠、后有斜杠」的形式：'/' 或 '/yike/' */
function normalizeBase(raw) {
  // 和 vite.config.ts 同样的拦截：Git Bash（MSYS2）会把 /yike/ 转换成
  // C:/Users/.../yike/。不拦的话校验会拿一个荒唐的 base 去比对，
  // 报出 10 条看不懂的错误 —— 让人误以为产物有问题，其实是参数被改了。
  if (raw.includes(':') || (raw !== '/' && !raw.startsWith('/'))) {
    console.error(`✗ 部署基路径不合法：${raw}`)
    console.error('  如果你在 Windows 的 Git Bash 里跑，MSYS 会把 /yike/ 转换成 Windows 路径。')
    console.error('  请改用：MSYS_NO_PATHCONV=1 node scripts/check-base.mjs /yike/')
    process.exit(1)
  }
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed === '' ? '/' : `/${trimmed}/`
}

const base = normalizeBase(process.argv[2] ?? '/')

const problems = []
let checked = 0

/** 检查一个绝对路径：必须带 base 前缀，且去掉前缀后文件真实存在 */
function checkPath(label, pathname) {
  if (!pathname.startsWith('/')) return
  if (!pathname.startsWith(base)) {
    problems.push(`${label}\n     ${pathname}\n     └ 缺少 base 前缀 ${base}`)
    return
  }
  const relative = pathname.slice(base.length)
  if (!existsSync(resolve(distDir, relative))) {
    problems.push(`${label}\n     ${pathname}\n     └ dist/ 里找不到 ${relative === '' ? '(根目录)' : relative}`)
    return
  }
  checked += 1
}

// ---------- 1. index.html ----------

const indexPath = resolve(distDir, 'index.html')
if (!existsSync(indexPath)) {
  console.error('✗ dist/index.html 不存在，请先执行 npm run build')
  process.exit(1)
}

const html = readFileSync(indexPath, 'utf8')
const attrPattern = /(?:href|src)="([^"]+)"/g
for (const match of html.matchAll(attrPattern)) {
  const value = match[1]
  if (value === undefined) continue
  // 外链、协议相对、内联数据一律不管
  if (/^(?:[a-z]+:|\/\/|#)/i.test(value)) continue
  checkPath(`index.html 的 ${value.startsWith('/') ? '绝对' : '相对'}引用`, value)
}

// ---------- 2. manifest.webmanifest ----------

const manifestPath = resolve(distDir, 'manifest.webmanifest')
if (!existsSync(manifestPath)) {
  problems.push('manifest.webmanifest\n     └ 产物里没有这个文件，PWA 无法安装')
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const manifestUrl = new URL(`https://example.invalid${base}manifest.webmanifest`)

  // 相对路径按 manifest 自己的位置解析，绝对路径原样 —— 与浏览器行为一致
  const resolveFromManifest = (value) => new URL(value, manifestUrl).pathname

  checkPath('manifest.start_url', resolveFromManifest(manifest.start_url ?? '/'))
  checkPath('manifest.scope', resolveFromManifest(manifest.scope ?? '/'))

  for (const icon of manifest.icons ?? []) {
    checkPath(`manifest 图标 ${icon.sizes}`, resolveFromManifest(icon.src))
  }
}

// ---------- 3. Service Worker ----------

if (!existsSync(resolve(distDir, 'sw.js'))) {
  problems.push('sw.js\n     └ 产物里没有 Service Worker，离线与可安装性都会失效')
}

// ---------- 输出 ----------

console.log(`部署基路径：${base}`)
console.log(`已校验 ${checked} 条资源路径`)

if (problems.length > 0) {
  console.error(`\n✗ 发现 ${problems.length} 处路径问题：\n`)
  for (const problem of problems) console.error(`  • ${problem}`)
  console.error('\n部署到子路径前必须修好，否则线上会白屏或图标 404。')
  process.exit(1)
}

console.log('✓ 所有资源路径都与部署基路径一致')
