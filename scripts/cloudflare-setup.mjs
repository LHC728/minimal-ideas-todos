#!/usr/bin/env node
/**
 * 一刻 —— Cloudflare 跨设备同步「一键部署」。
 *
 * 目标：让一个不写代码的人也能把同步后端跑起来。
 * 你只需要在浏览器里点一次「同意授权」，剩下全自动。
 *
 * 它会依次做这些事（每一步都可重复执行，不会弄坏已有的东西）：
 *   1. 确认 wrangler 已登录 Cloudflare
 *   2. 建好（或复用）名为 yike-sync 的 D1 数据库
 *   3. 把 database_id 回填进 worker/wrangler.toml
 *   4. 应用 worker/schema.sql（create table if not exists，重复跑没关系）
 *   5. 确认账号有 workers.dev 子域名（没有就自动注册一个）
 *   6. 部署 Worker
 *   7. 生成一个访问令牌，写进数据库（只存 SHA-256，明文只打印这一次）
 *   8. 现场自测：请求 /api/health 和 /api/me，确认真的通了
 *
 * 用法：
 *   npm run cloudflare:setup                   # 完整流程
 *   npm run cloudflare:setup -- --dry-run      # 只打印将要做什么，不真的动手
 *   npm run cloudflare:setup -- --token-only   # 库已建好，只补发一个新令牌
 *   npm run cloudflare:setup -- --subdomain=abc  # 指定 workers.dev 子域名
 *
 * 注意：这个脚本会往数据库写东西，但**永远不会删任何记录**。
 * 它也不碰你手机/电脑上的本地数据 —— 那些记录在应用自己的 IndexedDB 里。
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

const ROOT = process.cwd()
const WORKER_DIR = 'worker'
const TOML_PATH = 'worker/wrangler.toml'
const SCHEMA_PATH = 'worker/schema.sql'
/**
 * 临时 SQL 的落盘位置。
 *
 * 放系统临时目录，不放仓库里 —— 这样不需要 .gitignore 兜着，
 * 也不会在你 git status 里冒出一个陌生文件。
 * 名字带随机后缀，避免两次运行互相覆盖。
 */
const TEMP_SQL = join(tmpdir(), `yike-setup-${randomBytes(4).toString('hex')}.sql`)

const DB_NAME = 'yike-sync'
/** 固定主版本，避免某天 wrangler 出 5.x 时脚本突然换了行为 */
const WRANGLER = 'wrangler@4'
const PLACEHOLDER_ID = 'REPLACE_WITH_YOUR_DATABASE_ID'
const API_BASE = 'https://api.cloudflare.com/client/v4'

const flags = new Map()
for (const arg of process.argv.slice(2)) {
  const index = arg.indexOf('=')
  flags.set(index === -1 ? arg : arg.slice(0, index), index === -1 ? true : arg.slice(index + 1))
}
const DRY_RUN = flags.has('--dry-run')
const TOKEN_ONLY = flags.has('--token-only')
const SUBDOMAIN_WANTED = typeof flags.get('--subdomain') === 'string' ? flags.get('--subdomain') : null

// ---------------------------------------------------------------
// 输出
// ---------------------------------------------------------------

const say = (text = '') => process.stdout.write(`${text}\n`)

function heading(step, text) {
  say()
  say('─'.repeat(64))
  say(`  ${step}. ${text}`)
  say('─'.repeat(64))
}

/**
 * 计算文本在终端里占几列。
 *
 * 中日韩字符占两列 —— 直接用 `.length` 的话框线会歪，
 * 而歪掉的框恰好出现在「请复制这两样东西」那里，最不该出岔子的地方。
 */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

function box(lines) {
  const width = Math.max(...lines.map(displayWidth)) + 2
  say(`┌${'─'.repeat(width)}┐`)
  for (const line of lines) {
    say(`│ ${line}${' '.repeat(width - displayWidth(line) - 1)}│`)
  }
  say(`└${'─'.repeat(width)}┘`)
}

function die(message, hint) {
  say()
  say(`✗ ${message}`)
  if (hint) {
    say()
    for (const line of hint) say(`  ${line}`)
  }
  process.exit(1)
}

// ---------------------------------------------------------------
// 调用 wrangler
// ---------------------------------------------------------------

/**
 * 跑一次 wrangler。
 *
 * 参数里刻意不放任何含空格的东西（SQL 一律走 --file），
 * 因为 Windows 上必须借 shell 才能执行 npx.cmd，
 * 一旦有空格就得处理两套转义规则，那种代码迟早会在某台机器上炸。
 */
function wrangler(args, { capture = false } = {}) {
  if (DRY_RUN) {
    say(`  [dry-run] npx ${WRANGLER} ${args.join(' ')}`)
    return { status: 0, stdout: '', stderr: '' }
  }

  const isWindows = process.platform === 'win32'
  const result = spawnSync(isWindows ? 'npx.cmd' : 'npx', [WRANGLER, ...args], {
    cwd: resolve(ROOT, WORKER_DIR),
    encoding: 'utf8',
    shell: isWindows,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.error) {
    die(`执行 wrangler 失败：${result.error.message}`, [
      '请确认本机装了 Node 20 以上，并且能联网。',
      `可以先手动试一次：cd ${WORKER_DIR} && npx ${WRANGLER} --version`,
    ])
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** 从 wrangler 的输出里抠出 JSON（它有时会在前面打几行进度提示） */
function extractJson(text) {
  const start = text.search(/[[{]/)
  if (start === -1) return null
  const candidate = text.slice(start)
  // 从后往前收缩，直到能解析
  for (let end = candidate.length; end > 0; end -= 1) {
    const slice = candidate.slice(0, end).trim()
    if (slice === '' || !/[\]}]$/.test(slice)) continue
    try {
      return JSON.parse(slice)
    } catch {
      // 继续收缩
    }
  }
  return null
}

// ---------------------------------------------------------------
// 前置检查
// ---------------------------------------------------------------

function preflight() {
  heading(0, '检查环境')

  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < 20) {
    die(`Node 版本太低（当前 ${process.versions.node}）`, [
      'Cloudflare 的工具链要求 Node 20 以上。',
      '升级后重新执行本脚本。',
    ])
  }
  say(`  Node ${process.versions.node}  ✓`)

  if (!existsSync(resolve(ROOT, SCHEMA_PATH))) {
    die(`找不到 ${SCHEMA_PATH}`, ['请在仓库根目录执行：npm run cloudflare:setup'])
  }
  if (!existsSync(resolve(ROOT, TOML_PATH))) {
    die(`找不到 ${TOML_PATH}`, ['请在仓库根目录执行：npm run cloudflare:setup'])
  }
  say(`  找到 ${SCHEMA_PATH} 与 ${TOML_PATH}  ✓`)
  say()
  say('  提示：第一次运行会先下载 wrangler（几十 MB），可能要等一会儿。')
}

/**
 * 判断 wrangler 是「跑起来了但没登录」，还是**根本没启动**。
 *
 * 这个区分很重要：npx 的下载缓存坏掉时（安装被中途打断的常见后果），
 * 命令返回非 0 但输出是模块找不到 —— 如果一律报「还没登录」，
 * 用户会跑去重新登录，而真正的问题在缓存，永远修不好。
 *
 * 后两条（EBUSY / EPERM）是同一个病的另一种表现：包已经下下来了，
 * 但它的安装脚本（esbuild、workerd 都会去 spawn 一次 node）跑不动。
 * 症状完全不像「没登录」，却同样和登录无关。
 */
function looksLikeToolchainFailure(output) {
  return /cannot find module|could not be found|ERR_MODULE_NOT_FOUND|is not recognized|EBUSY|EPERM: operation not permitted/i.test(
    output,
  )
}

function toolchainHint(output) {
  return [
    '这不是登录问题 —— 是 wrangler 本身没跑起来，多半是 npx 的下载缓存坏了',
    '（常见于安装过程被中途打断）。',
    '',
    '不用去删那个坏缓存（删它本身也可能被拦住），换一个全新的空目录重跑即可：',
    '',
    '    npm_config_cache=<一个全新的空目录> npm run cloudflare:setup',
    '',
    '如果换了新目录还是同样的错，那就是安装脚本本身跑不动了',
    '（wrangler 依赖的 esbuild / workerd 会在 postinstall 里去 spawn node，',
    ' 被拦时只报 EBUSY / EPERM，看起来和「缓存坏了」一模一样）。',
    '这时跳过安装脚本、装到隔离目录里直接调用它的入口：',
    '',
    '    npm install --ignore-scripts --prefix <临时目录> wrangler@4',
    '    node <临时目录>/node_modules/wrangler/bin/wrangler.js d1 execute ...',
    '',
    '（`d1 execute` 不需要 esbuild 与 workerd，跳过安装脚本不影响它。）',
    '',
    '原始输出：',
    output.trim(),
  ]
}

function requireLogin() {
  heading(1, '确认已登录 Cloudflare')

  const result = wrangler(['whoami'], { capture: true })
  if (DRY_RUN) return result.stdout

  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`
    if (looksLikeToolchainFailure(output)) {
      die('wrangler 没能启动（不是登录问题）。', toolchainHint(output))
    }
    die('还没登录 Cloudflare。', [
      '登录是一次性的，会在浏览器里点一下「同意」：',
      '',
      `    cd ${WORKER_DIR}`,
      `    npx ${WRANGLER} login`,
      '',
      '登录完成后再回来执行：npm run cloudflare:setup',
      '',
      '（没有 Cloudflare 账号的话，去 https://dash.cloudflare.com/sign-up 免费注册，',
      '  不用绑信用卡。免费额度是每天 10 万次请求 + 5GB 存储，个人用远远够。）',
    ])
  }
  say('  已登录  ✓')
  return result.stdout
}

// ---------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------

function ensureDatabase() {
  heading(2, `建好（或复用）D1 数据库「${DB_NAME}」`)

  if (DRY_RUN) {
    say(`  [dry-run] 将执行 npx ${WRANGLER} d1 list --json 查有没有现成的`)
    say(`  [dry-run] 没有的话就 npx ${WRANGLER} d1 create ${DB_NAME}`)
    return '<dry-run 数据库 id>'
  }

  const listed = wrangler(['d1', 'list', '--json'], { capture: true })
  const parsed = extractJson(listed.stdout)

  const existing = Array.isArray(parsed)
    ? parsed.find((item) => item && typeof item === 'object' && item.name === DB_NAME)
    : null

  if (existing && typeof existing.uuid === 'string') {
    say(`  已有同名数据库，直接复用：${existing.uuid}`)
    return existing.uuid
  }

  say('  没找到，新建一个…')
  const created = wrangler(['d1', 'create', DB_NAME], { capture: true })
  const output = `${created.stdout}\n${created.stderr}`

  if (created.status !== 0 && !output.includes(DB_NAME)) {
    die('创建 D1 数据库失败。', ['原始输出：', output.trim()])
  }

  const matched = /database_id\s*=\s*"([^"]+)"/.exec(output)
  if (matched?.[1]) {
    say(`  建好了：${matched[1]}`)
    return matched[1]
  }

  // 输出格式变了也不要紧，再列一次
  const again = extractJson(wrangler(['d1', 'list', '--json'], { capture: true }).stdout)
  const found = Array.isArray(again)
    ? again.find((item) => item && typeof item === 'object' && item.name === DB_NAME)
    : null
  if (found && typeof found.uuid === 'string') return found.uuid

  die('数据库建好了，但没能从输出里读到它的 id。', [
    '请手动执行下面的命令，把 database_id 填进 worker/wrangler.toml：',
    '',
    `    cd ${WORKER_DIR}`,
    `    npx ${WRANGLER} d1 list`,
  ])
}

function patchToml(databaseId) {
  heading(3, '把 database_id 写进 worker/wrangler.toml')

  const path = resolve(ROOT, TOML_PATH)
  const before = readFileSync(path, 'utf8')

  if (before.includes(databaseId)) {
    say('  已经是这个 id 了，不用改  ✓')
    return
  }

  const after = before.replace(
    new RegExp(`database_id\\s*=\\s*"[^"]*"`),
    `database_id = "${databaseId}"`,
  )

  if (after === before) {
    die(`${TOML_PATH} 里没找到 database_id 那一行。`, [
      '请手动加上：',
      '',
      '    [[d1_databases]]',
      '    binding = "DB"',
      `    database_name = "${DB_NAME}"`,
      `    database_id = "${databaseId}"`,
    ])
  }

  if (DRY_RUN) {
    say('  [dry-run] 将写入 database_id')
    return
  }

  writeFileSync(path, after, 'utf8')
  say('  写好了  ✓')
  say()
  say(`  注意：${TOML_PATH} 因此会有改动。这不是密钥，可以放心提交。`)
}

function applySchema() {
  heading(4, '建表（重复执行不会破坏已有数据）')

  const result = wrangler(['d1', 'execute', DB_NAME, '--remote', '--file=schema.sql'])
  if (!DRY_RUN && result.status !== 0) {
    die('建表失败。', [
      '最常见的原因是 database_id 填错了，或者账号没权限。',
      `可以先单独试一次：cd ${WORKER_DIR} && npx ${WRANGLER} d1 execute ${DB_NAME} --remote --file=schema.sql`,
    ])
  }
  say('  表结构就绪  ✓')
}

// ---------------------------------------------------------------
// workers.dev 子域名
// ---------------------------------------------------------------

/** 从 `wrangler whoami` 的输出里读账号 ID */
function accountIdFrom(whoamiOutput) {
  const matches = whoamiOutput.match(/\b[0-9a-f]{32}\b/g) ?? []
  if (matches.length === 0) {
    die('没能从 wrangler 的输出里读到账号 ID。', [
      '请手动执行下面的命令，把输出发我，或自己去控制台确认：',
      '',
      `    cd ${WORKER_DIR}`,
      `    npx ${WRANGLER} whoami`,
    ])
  }
  return matches[0]
}

/** 登录邮箱的用户名部分，用来当子域名的首选候选 */
function subdomainCandidateFrom(whoamiOutput) {
  const email = /associated with the email ([^\s!]+)/i.exec(whoamiOutput)?.[1] ?? ''
  const name = email.split('@')[0] ?? ''
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
  return /^[a-z0-9]/.test(cleaned) ? cleaned : null
}

/**
 * 确保账号有一个 workers.dev 子域名，返回它。
 *
 * 为什么要走这一步：wrangler 没有「注册子域名」的命令，而 deploy 在
 * 非交互环境下遇到「还没注册子域名」只会直接失败 —— 用户就被卡在一个
 * 只有 URL 前缀、却要跑去翻控制台的死胡同里。
 * 令牌是 wrangler 刚写下的，这里只是替它读一次，不会外传。
 */
async function ensureSubdomain(whoamiOutput) {
  heading(5, '确认 workers.dev 子域名（一次性）')

  if (DRY_RUN) {
    say('  [dry-run] 将检查并（必要时）注册一个 workers.dev 子域名')
    return 'dry-run-subdomain'
  }

  const accountId = accountIdFrom(whoamiOutput)
  const token = readOAuthToken()
  if (token === null) {
    say('  ⚠ 读不到 wrangler 的登录令牌，跳过这一步。')
    say('    如果接下来的部署报「需要先注册 workers.dev 子域名」，去这里填一个名字：')
    say(`    https://dash.cloudflare.com/${accountId}/workers/onboarding`)
    return null
  }

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const endpoint = `${API_BASE}/accounts/${accountId}/workers/subdomain`

  const current = await fetch(endpoint, { headers })
    .then((response) => response.json())
    .catch(() => null)

  const existing = current?.result?.subdomain
  if (typeof existing === 'string' && existing !== '') {
    say(`  已有子域名：${existing}.workers.dev  ✓`)
    return existing
  }

  const candidates = [
    SUBDOMAIN_WANTED,
    subdomainCandidateFrom(whoamiOutput),
    `yike-${randomBytes(3).toString('hex')}`,
  ].filter((item) => typeof item === 'string' && item !== '')

  for (const candidate of candidates) {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ subdomain: candidate }),
    })
    const payload = await response.json().catch(() => null)

    if (response.ok && payload?.success !== false) {
      say(`  注册好了：${candidate}.workers.dev  ✓`)
      return candidate
    }

    const reason = payload?.errors?.[0]?.message ?? `HTTP ${response.status}`
    say(`  「${candidate}」不可用（${reason}），换一个再试…`)
  }

  die('没能注册 workers.dev 子域名。', [
    '名字可能都被占用了。请打开下面这个链接自己填一个，然后重新执行本脚本：',
    '',
    `  https://dash.cloudflare.com/${accountId}/workers/onboarding`,
    '',
    '也可以直接指定：npm run cloudflare:setup -- --subdomain=你想要的名字',
  ])
}

/** 从 wrangler.toml 里读 Worker 名字（默认部署地址的第一段就是它） */
function workerName() {
  const content = readFileSync(resolve(ROOT, TOML_PATH), 'utf8')
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(content)?.[1] ?? 'yike-sync'
}

/**
 * 读 wrangler 自己存的 OAuth 令牌（ensureSubdomain 拿它去调 API）。
 * 令牌是 wrangler 刚写下的，这里只是替它读一次，不会外传。
 */
function readOAuthToken() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.wrangler', 'config', 'default.toml'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const matched = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(path, 'utf8'))
    if (matched?.[1]) return matched[1]
  }
  return null
}

// ---------------------------------------------------------------
// 部署
// ---------------------------------------------------------------

function deploy() {
  heading(6, '部署 Worker')

  const result = wrangler(['deploy'], { capture: true })
  const output = `${result.stdout}\n${result.stderr}`

  if (!DRY_RUN) process.stdout.write(result.stdout)

  if (!DRY_RUN && result.status !== 0) {
    die('部署失败。', ['原始输出：', output.trim()])
  }

  const matched = /(https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev)/i.exec(output)
  if (!matched?.[1]) {
    if (DRY_RUN) return 'https://<你的-worker>.workers.dev'
    die('部署似乎成功了，但没能从输出里认出访问地址。', [
      '请把上面输出里的 workers.dev 地址复制下来，填进应用的「设置 → 云端同步」。',
    ])
  }

  const url = matched[1].replace(/\/+$/, '')
  say()
  say(`  地址：${url}  ✓`)
  return url
}

// ---------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------

function issueToken() {
  heading(7, '生成访问令牌')

  // 明文只在这里存在一次，之后库里只有它的 SHA-256
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const newUserId = randomUUID()
  const now = new Date().toISOString()
  const label = `setup ${now.slice(0, 10)}`

  // 全部交给数据库判断，避免「先查再插」之间的竞态。
  //   1. 库是空的 → 建一个账号
  //   2. 给「最早的账号」发一个新令牌（没有账号就用刚建的那个）
  //   3. 把结果回显出来，脚本据此告诉用户令牌属于哪个账号
  const sql = [
    '-- 由 scripts/cloudflare-setup.mjs 生成，执行后会被删除',
    'insert into users (id, email, created_at)',
    `select '${newUserId}', null, '${now}'`,
    'where not exists (select 1 from users);',
    '',
    'insert into access_tokens (token_hash, user_id, label, created_at)',
    `select '${tokenHash}', (select id from users order by created_at, id limit 1), '${label}', '${now}';`,
    '',
    'select u.id as user_id, u.email as email,',
    '       (select count(*) from records where user_id = u.id) as record_count,',
    '       (select count(*) from access_tokens where user_id = u.id) as token_count',
    '  from users u',
    ' where u.id = (select id from users order by created_at, id limit 1);',
  ].join('\n')

  const tempPath = TEMP_SQL

  if (DRY_RUN) {
    say('  [dry-run] 将生成一个 43 字符的随机令牌并写入数据库')
    say('  [dry-run] 临时 SQL 会写到系统临时目录，执行后删除')
    // 这里刻意返回占位符而不是上面那个真随机串：
    // dry-run 的收尾框会把它显示成「访问令牌」，真串会被误当成可用令牌复制走。
    return { token: '<运行后这里会出现真实令牌>', url: null }
  }

  writeFileSync(tempPath, sql, 'utf8')

  let result
  try {
    // 全脚本只有这一个参数带引号：临时目录的路径可能含空格
    // （用户名里有空格就会），不引的话 Windows 上会被 shell 从空格处切断。
    result = wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', `--file="${tempPath}"`], {
      capture: true,
    })
  } finally {
    // 清理失败绝不能让整轮部署白跑 —— 令牌此刻已经写进数据库了，
    // 在这里再抛异常就等于把刚生成的明文令牌直接扔掉（真实踩过这一次）。
    try {
      rmSync(tempPath, { force: true })
    } catch {
      say(`  ⚠ 临时文件没能自动删掉，请手动删除：${tempPath}`)
    }
  }

  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) {
    die('写入令牌失败。', ['原始输出：', output.trim()])
  }

  const parsed = extractJson(result.stdout)
  const row = Array.isArray(parsed)
    ? parsed.find((item) => Array.isArray(item?.results) && item.results.length > 0)?.results[0]
    : null

  if (row && typeof row.user_id === 'string') {
    say(`  账号：${row.user_id}`)
    if (typeof row.record_count === 'number') {
      say(`  这个账号下已有 ${row.record_count} 条记录（说明你在复用一个已有账号，数据没丢）`)
    }
  } else {
    say('  令牌已写入。')
    say('  （没能从输出里读到账号信息，不影响使用）')
  }

  return { token, url: null }
}

// ---------------------------------------------------------------
// 现场自测
// ---------------------------------------------------------------

async function selfCheck(url, token) {
  heading(8, '现场自测（不靠猜）')

  if (DRY_RUN) {
    say('  [dry-run] 将请求 /api/health 与 /api/me')
    return
  }

  // 刚部署完，边缘节点可能还在生效中，给它一点时间
  let health = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) {
        health = await response.json()
        break
      }
      say(`  第 ${attempt} 次健康检查返回 ${response.status}，等 3 秒再试…`)
    } catch (error) {
      say(`  第 ${attempt} 次健康检查失败（${error.message}），等 3 秒再试…`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
  }

  if (health === null) {
    die('部署完成了，但 /api/health 一直没通。', [
      '等一两分钟再试，或者去 Cloudflare 控制台看看 Worker 有没有报错：',
      '  https://dash.cloudflare.com → Workers & Pages → yike-sync',
    ])
  }
  say(`  /api/health  ✓  ${JSON.stringify(health)}`)

  const meResponse = await fetch(`${url}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!meResponse.ok) {
    die(`令牌自测失败（HTTP ${meResponse.status}）。`, [
      '令牌没能通过鉴权，说明数据库里那条 access_tokens 没写进去。',
      '可以重新执行一次：npm run cloudflare:setup -- --token-only',
    ])
  }

  const me = await meResponse.json()
  say(`  /api/me      ✓  ${JSON.stringify(me)}`)
  say()
  say('  后端真的通了 —— 这一条是实测出来的，不是推断的。')
}

// ---------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------

function printNextSteps(url, token, databaseId) {
  heading('完成', '把这两样东西填进应用')

  say()
  say('  打开你的「一刻」（手机上或电脑上都行）：')
  say()
  say('    1. 左下角「设置」→ 云端同步 → 选「Cloudflare（自建）」')
  say('    2. 把下面两行分别粘进去，保存')
  say('    3. 回到设置，点「登录」')
  say()

  box([
    `Worker 地址：${url}`,
    `访问令牌　：${token}`,
  ])

  say()
  say('  ⚠️ 令牌只在上面显示这一次。库里存的是它的 SHA-256，')
  say('     事后无法从数据库里取回明文 —— 请现在就复制走。')
  say('     （丢了也不要紧：重跑一次脚本就会发一个新的。）')
  say()
  say('  如果手机和电脑都要同步，两台设备填**同一个**地址和令牌。')
  say()
  say('─'.repeat(64))
  say('  其它几件事')
  say('─'.repeat(64))
  say()
  say(`  · 数据库 id（记一下，换机器时用得上）：${databaseId}`)
  say(`  · ${TOML_PATH} 被改过，建议提交：git add ${TOML_PATH}`)
  say()
  say('  · 想吊销这个令牌（例如手机丢了）：')
  say(`      cd ${WORKER_DIR}`)
  say(`      npx ${WRANGLER} d1 execute ${DB_NAME} --remote --command "update access_tokens set revoked_at = datetime('now') where revoked_at is null"`)
  say()
  say('  · 想看后端日志：')
  say(`      cd ${WORKER_DIR} && npx ${WRANGLER} tail`)
  say()
  say('  · 想收紧跨域（可选，不收紧也不影响安全）：')
  say(`      编辑 ${TOML_PATH}，把 ALLOWED_ORIGINS 那行的注释去掉`)
  say()
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------

async function main() {
  say()
  say('一刻 · Cloudflare 跨设备同步部署')
  if (DRY_RUN) say('（dry-run：只打印将要做什么，不会真的动手）')

  preflight()
  const whoamiOutput = requireLogin()

  if (TOKEN_ONLY) {
    const databaseId = readDatabaseIdFromToml()
    // 地址是确定可推的：<wrangler.toml 里的 name>.<子域名>.workers.dev
    // 所以「只补令牌」这条路也能现场自测，而不是让你填完才发现不通。
    const subdomain = await ensureSubdomain(whoamiOutput)
    const { token } = issueToken()
    const url = subdomain ? `https://${workerName()}.${subdomain}.workers.dev` : null
    if (url !== null) {
      await selfCheck(url, token)
    } else {
      say()
      say('  ⚠ 没拿到子域名，跳过自测。填进应用后如果连不上，再跑一次完整流程。')
    }
    say()
    say('  只补发了令牌，没有重新部署。')
    printNextSteps(url ?? '（沿用你之前填的地址，没变）', token, databaseId)
    return
  }

  const databaseId = ensureDatabase()
  patchToml(databaseId)
  applySchema()
  await ensureSubdomain(whoamiOutput)
  const url = deploy()
  const { token } = issueToken()
  await selfCheck(url, token)
  printNextSteps(url, token, databaseId)
}

function readDatabaseIdFromToml() {
  const content = readFileSync(resolve(ROOT, TOML_PATH), 'utf8')
  const matched = /database_id\s*=\s*"([^"]+)"/.exec(content)
  if (!matched?.[1] || matched[1] === PLACEHOLDER_ID) {
    die(`${TOML_PATH} 里还没有真正的 database_id。`, [
      '先完整跑一次：npm run cloudflare:setup',
    ])
  }
  return matched[1]
}

main().catch((error) => {
  say()
  say(`✗ 出错了：${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack) say(error.stack)
  process.exit(1)
})
