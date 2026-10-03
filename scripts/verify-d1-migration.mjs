/**
 * 一次性验证脚本：在真实 SQLite 上跑一遍 D1 迁移 0002。
 *
 * 为什么不用 vitest：本机沙箱会拦 jsdom 的文件读取，导致 vitest 的
 * worker 起不来（`Cannot read properties of undefined (reading 'config')`）。
 * 那是环境问题不是代码问题 —— 同一个现象在改动前就存在。
 * 但迁移脚本必须**现在就**验一遍，不能等 CI，所以这里直接用 node:sqlite。
 *
 * 用法：node scripts/verify-d1-migration.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = process.cwd()
// 0002 之前的完整 schema（冻结副本）。用它当输入，迁移结果才能和
// 「全新安装」逐项对比 —— 只建一张 records 表的残缺 fixture 会得出
// 「触发器数量不一致」「索引集合不一致」这种假警报。
const LEGACY = readFileSync(resolve(root, 'worker/migrations/__fixtures__/schema-0001.sql'), 'utf8')

const MIGRATION = readFileSync(resolve(root, 'worker/migrations/0002_project_type.sql'), 'utf8')
const SCHEMA = readFileSync(resolve(root, 'worker/schema.sql'), 'utf8')

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  —— ${detail}` : ''}\n`)
}

function mustThrow(label, fn, pattern) {
  try {
    fn()
    check(label, false, '本该抛错却成功了')
  } catch (error) {
    const message = String(error?.message ?? error)
    check(label, pattern.test(message), message.slice(0, 70))
  }
}

const SEED = [
  ['r-idea', 'idea', '一个点子', null, 3],
  ['r-todo', 'todo', '一件事', null, 1],
  ['r-gone', 'idea', '删掉的', '2026-09-29T00:00:00.000Z', 5],
]

function seed(db) {
  for (const [id, type, content, deleted, version] of SEED) {
    db.prepare(
      `insert into records (id, user_id, type, content, created_at_utc, created_timezone,
         created_local_date, updated_at_utc, updated_timezone, completed_at_utc,
         completed_timezone, deleted_at_utc, version, server_updated_at)
       values (?, 'u-1', ?, ?, '2026-09-30T01:00:00.000Z', 'Asia/Shanghai', '2026-09-30',
         '2026-09-30T01:00:00.000Z', 'Asia/Shanghai', null, null, ?, ?, '2026-09-30T01:00:00.000Z')`,
    ).run(id, type, content, deleted, version)
  }
}

process.stdout.write('\n【前提】老库装不下 project\n')
{
  const db = new DatabaseSync(':memory:')
  db.exec(LEGACY)
  mustThrow(
    '老表的 CHECK 拒绝 project',
    () =>
      db
        .prepare(
          `insert into records (id, user_id, type, content, created_at_utc, created_timezone,
             created_local_date, updated_at_utc, version, server_updated_at)
           values ('r-p','u-1','project','x','2026-10-01T00:00:00.000Z','UTC','2026-10-01',
             '2026-10-01T00:00:00.000Z',1,'2026-10-01T00:00:00.000Z')`,
        )
        .run(),
    /constraint/i,
  )
  db.close()
}

process.stdout.write('\n【迁移】跑 0002\n')
const db = new DatabaseSync(':memory:')
db.exec(LEGACY)
seed(db)
db.exec(MIGRATION)

process.stdout.write('\n【1】数据一条不少、一列不串\n')
{
  const rows = db.prepare('select * from records order by id').all()
  check('三条记录都在', rows.length === SEED.length, `实际 ${rows.length}`)
  const byId = new Map(rows.map((r) => [r.id, r]))
  let allGood = true
  for (const [id, type, content, deleted, version] of SEED) {
    const row = byId.get(id)
    const good =
      row &&
      row.type === type &&
      row.content === content &&
      row.deleted_at_utc === deleted &&
      row.version === version &&
      row.created_local_date === '2026-09-30'
    if (!good) allGood = false
  }
  check('逐字段与迁移前一致', Boolean(allGood))
  check(
    '新列补成 null',
    rows.every((r) => r.progress === null && r.deadline_local_date === null),
  )
}

process.stdout.write('\n【2】索引与触发器一个都不能少\n')
{
  const tables = db
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
    .all()
    .map((r) => r.name)
  check('留底表已清除', !tables.includes('records_legacy'), tables.join(','))

  const idx = db
    .prepare("select name, tbl_name from sqlite_master where type='index' and name not like 'sqlite_%'")
    .all()
  for (const name of [
    'records_user_id_idx',
    'records_user_local_date_idx',
    'records_user_type_idx',
    'records_user_server_updated_idx',
  ]) {
    const row = idx.find((r) => r.name === name)
    check(`索引 ${name}`, row?.tbl_name === 'records', row ? `挂在 ${row.tbl_name}` : '不存在')
  }

  const trg = db
    .prepare("select name from sqlite_master where type='trigger' order by name")
    .all()
    .map((r) => r.name)
  const expected = [
    'applied_mutations_no_rewrite',
    'records_created_fields_immutable',
    'records_no_hard_delete',
    'records_version_must_increase',
  ]
  check('四个触发器一个不少', JSON.stringify(trg) === JSON.stringify(expected), trg.join(','))
}

process.stdout.write('\n【3】红线依然有效（触发器真的在工作）\n')
mustThrow('物理删除被拒', () => db.exec("delete from records where id='r-idea'"), /records_must_be_soft_deleted/)
check(
  '删不掉，行数没变',
  db.prepare('select count(*) as n from records').get().n === SEED.length,
)
mustThrow(
  'created_at 改不动',
  () => db.exec("update records set created_at_utc='1999-01-01T00:00:00.000Z', version=9 where id='r-idea'"),
  /created_fields_are_immutable/,
)
mustThrow(
  'type 改不动',
  () => db.exec("update records set type='todo', version=9 where id='r-idea'"),
  /created_fields_are_immutable/,
)
mustThrow(
  'version 不许倒退',
  () => db.exec("update records set content='x', version=1 where id='r-idea'"),
  /version_must_increase/,
)
db.exec("update records set content='x', version=4 where id='r-idea'")
check('正常 +1 放行', db.prepare("select content from records where id='r-idea'").get().content === 'x')

process.stdout.write('\n【4】新能力可用、新约束在拦\n')
{
  db.prepare(
    `insert into records (id, user_id, type, content, progress, deadline_local_date,
       created_at_utc, created_timezone, created_local_date, updated_at_utc, version, server_updated_at)
     values ('r-p','u-1','project','毕业论文',60,'2026-10-12','2026-10-01T00:00:00.000Z',
       'Asia/Shanghai','2026-10-01','2026-10-01T00:00:00.000Z',1,'2026-10-01T00:00:00.000Z')`,
  ).run()
  const row = db.prepare("select progress, deadline_local_date from records where id='r-p'").get()
  check('能插 project 并带进度与截止日', row.progress === 60 && row.deadline_local_date === '2026-10-12')

  mustThrow(
    '灵感不许带进度',
    () => db.exec("update records set progress=50, version=9 where id='r-idea'"),
    /constraint/i,
  )
  mustThrow(
    '待办不许带截止日',
    () => db.exec("update records set deadline_local_date='2026-10-12', version=9 where id='r-todo'"),
    /constraint/i,
  )
  mustThrow(
    '进度 140 被拒',
    () => db.exec("update records set progress=140, version=2 where id='r-p'"),
    /constraint/i,
  )
  mustThrow(
    '进度 -1 被拒',
    () => db.exec("update records set progress=-1, version=2 where id='r-p'"),
    /constraint/i,
  )
}

process.stdout.write('\n【5】迁移结果 == 全新安装\n')
{
  const fresh = new DatabaseSync(':memory:')
  fresh.exec(SCHEMA)

  const shape = (d) =>
    JSON.stringify(
      d
        .prepare('pragma table_info(records)')
        .all()
        .map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk])
        .toSorted(),
    )
  check('列名/类型/非空/默认值逐项一致', shape(db) === shape(fresh))

  const trgSql = (d) =>
    d
      .prepare("select name, sql from sqlite_master where type='trigger' order by name")
      .all()
      .map((r) => [r.name, r.sql.replace(/\s+/g, ' ').trim()])
  const a = trgSql(db)
  const b = trgSql(fresh)
  const same = JSON.stringify(a) === JSON.stringify(b)
  check('触发器定义逐字一致', same)
  if (!same) {
    for (const [name, sql] of a) {
      const other = b.find(([n]) => n === name)?.[1]
      if (other !== sql) {
        process.stdout.write(`      · ${name}\n        迁移: ${sql}\n        全新: ${other}\n`)
      }
    }
  }

  // 只比 records 上的索引 —— 这个 fixture 只建了 records 表，
  // 全新安装还会多出 access_tokens 的索引，那是 fixture 不完整，不是迁移的问题。
  const idxNames = (d) =>
    JSON.stringify(
      d
        .prepare(
          "select name from sqlite_master where type='index' and tbl_name='records' and name not like 'sqlite_%' order by name",
        )
        .all()
        .map((r) => r.name),
    )
  check('records 的索引集合一致', idxNames(db) === idxNames(fresh))
  fresh.close()
}

db.close()

const failed = results.filter((r) => !r.ok)
process.stdout.write(
  `\n${failed.length === 0 ? '全部通过' : `未通过 ${failed.length} 项`}（共 ${results.length} 项）\n\n`,
)
process.exit(failed.length === 0 ? 0 : 1)
