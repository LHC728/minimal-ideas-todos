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
 *   5. 部署 Worker
 *   6. 生成一个访问令牌，写进数据库（只存 SHA-256，明文只打印这一次）
 *   7. 现场自测：请求 /api/health 和 /api/me，确认真的通了
 *
 * 用法：
 *   npm run cloudflare:setup              # 完整流程
 *   npm run cloudflare:setup -- --dry-run # 只打印将要做什么，不真的动手
 *   npm run cloudflare:setup -- --token-only  # 库已建好，只补发一个新令牌
 *
 * 注意：这个脚本会往数据库写东西，但**永远不会删任何记录**。
 * 它也不碰你手机/电脑上的本地数据 —— 那些记录在应用自己的 IndexedDB 里。
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------
// 常量
// ---------------------------------------------------------------

const ROOT = process.cwd()
const WORKER_DIR = 'worker'
const TOML_PATH = 'worker/wrangler.toml'
const SCHEMA_PATH = 'worker/schema.sql'
const TEMP_SQL = '.tmp-setup.sql'

const DB_NAME = 'yike-sync'
/** 固定主版本，避免某天 wrangler 出 5.x 时脚本突然换了行为 */
const WRANGLER = 'wrangler@4'
const PLACEHOLDER_ID = 'REPLACE_WITH_YOUR_DATABASE_ID'

const argv = new Set(process.argv.slice(2))
const DRY_RUN = argv.has('--dry-run')
const TOKEN_ONLY = argv.has('--token-only')

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

function requireLogin() {
  heading(1, '确认已登录 Cloudflare')

  const result = wrangler(['whoami'], { capture: true })
  if (DRY_RUN) return

  if (result.status !== 0) {
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
}

// ---------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------

function ensureDatabase() {
  heading(2, `建好（或复用）D1 数据库「${DB_NAME}」`)

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
// 部署
// ---------------------------------------------------------------

function deploy() {
  heading(5, '部署 Worker')

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
  heading(6, '生成访问令牌')

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

  const tempPath = resolve(ROOT, WORKER_DIR, TEMP_SQL)

  if (DRY_RUN) {
    say('  [dry-run] 将生成一个 43 字符的随机令牌并写入数据库')
    say(`  [dry-run] 临时 SQL 会写到 ${WORKER_DIR}/${TEMP_SQL}，执行后删除`)
    return { token, url: null }
  }

  writeFileSync(tempPath, sql, 'utf8')

  let result
  try {
    result = wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', `--file=${TEMP_SQL}`], {
      capture: true,
    })
  } finally {
    // 里面只有令牌的哈希，不是明文，但仍然没必要留在磁盘上
    rmSync(tempPath, { force: true })
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
  heading(7, '现场自测（不靠猜）')

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
  requireLogin()

  if (TOKEN_ONLY) {
    const databaseId = readDatabaseIdFromToml()
    const { token } = issueToken()
    say()
    say('  只补发令牌，没有重新部署。')
    printNextSteps('（沿用你之前填的地址，没变）', token, databaseId)
    return
  }

  const databaseId = ensureDatabase()
  patchToml(databaseId)
  applySchema()
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
