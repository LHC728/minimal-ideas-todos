// @vitest-environment node
/**
 * D1 迁移 0002 的验证 —— 在**真实 SQLite** 上，从老 schema + 真实数据跑到新 schema。
 *
 * 为什么必须单独测这一个迁移：
 *   它是本项目唯一一次需要**重建 records 表**的迁移（SQLite 改不了 CHECK 约束）。
 *   重建表 = drop 触发器 + rename + 建新表 + 搬数据 + drop 旧表 + 重建索引和触发器。
 *   这里面任何一步写漏都**不会报错**：
 *     · 索引忘了重建  → 查询悄悄退化成全表扫描，功能看着一切正常
 *     · 触发器忘了重建 → 「创建时间不可变」「只能软删除」这些红线**直接消失**
 *     · 列顺序写错    → 数据静默串列（content 里装着时间戳）
 *   这三种错人工核对都看不出来，所以必须让机器逐条验。
 *
 * 另外这里还钉住一件事：**迁移后的表结构必须与全新安装（schema.sql）逐列一致**。
 * 否则「老用户升级上来的库」和「新用户的库」会长得不一样，
 * 而这种差异通常要到几个月后某个查询出错才会暴露。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const SCHEMA = readFileSync(resolve(process.cwd(), 'worker/schema.sql'), 'utf8')

/**
 * ⚠️ 这是 0002 **之前**的完整 schema 冻结副本（连 users / access_tokens /
 * applied_mutations 和全部触发器一起），作为迁移测试的输入。
 * 它是历史事实，**永远不要跟着 worker/schema.sql 一起改** ——
 * 改了就等于拿新表结构去测新表结构，这个测试会彻底失去意义。
 *
 * 只留一张 records 表的残缺样本会得出「触发器数量不一致」「索引集合不一致」
 * 这种假警报 —— 实测踩过。
 */
const LEGACY_SCHEMA = readFileSync(
  resolve(process.cwd(), 'worker/migrations/__fixtures__/schema-0001.sql'),
  'utf8',
)

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'worker/migrations/0002_project_type.sql'),
  'utf8',
)

/** 线上库里的真实形态：活的 idea、活的 todo、一条软删除的墓碑 */
const SEED = [
  { id: 'r-idea', type: 'idea', content: '一个点子', deleted: null, version: 3 },
  { id: 'r-todo', type: 'todo', content: '一件事', deleted: null, version: 1 },
  {
    id: 'r-gone',
    type: 'idea',
    content: '删掉的',
    deleted: '2026-09-29T00:00:00.000Z',
    version: 5,
  },
]

function insertLegacy(
  db: DatabaseSync,
  row: (typeof SEED)[number],
): void {
  db.prepare(
    `insert into records (
       id, user_id, type, content,
       created_at_utc, created_timezone, created_local_date,
       updated_at_utc, updated_timezone,
       completed_at_utc, completed_timezone, deleted_at_utc,
       version, server_updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    'u-1',
    row.type,
    row.content,
    '2026-09-30T01:00:00.000Z',
    'Asia/Shanghai',
    '2026-09-30',
    '2026-09-30T01:00:00.000Z',
    'Asia/Shanghai',
    null,
    null,
    row.deleted,
    row.version,
    '2026-09-30T01:00:00.000Z',
  )
}

/** 老库 + 真实数据，然后跑迁移 */
function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(LEGACY_SCHEMA)
  for (const row of SEED) insertLegacy(db, row)
  db.exec(MIGRATION)
  return db
}

/** 全新安装（等价于 createSqliteD1 的建库步骤，但要拿到原生 DatabaseSync） */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`pragma table_info(${table})`).all().map((row) => String(row['name']))
}

function names(db: DatabaseSync, type: string): string[] {
  return db
    .prepare(`select name from sqlite_master where type = ? and name not like 'sqlite_%' order by name`)
    .all(type)
    .map((row) => String(row['name']))
}

// =====================================================================
describe('迁移前：老库确实装不下 project（先确认这个前提成立）', () => {
  it('老表的 CHECK 约束会拒绝 project', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_SCHEMA)
    expect(() => insertLegacy(db, { id: 'r-p', type: 'project', content: 'x', deleted: null, version: 1 }))
      .toThrow(/constraint/i)
    db.close()
  })
})

describe('迁移后：数据一条不少、一列不串', () => {
  it('三条记录逐字段与迁移前完全一致', () => {
    const db = migratedDb()
    const rows = db
      .prepare(
        `select id, user_id, type, content, created_at_utc, created_timezone,
                created_local_date, updated_at_utc, updated_timezone,
                completed_at_utc, completed_timezone, deleted_at_utc,
                version, server_updated_at
           from records order by id`,
      )
      .all()

    expect(rows).toHaveLength(SEED.length)
    const byId = new Map(rows.map((row) => [String(row['id']), row]))
    for (const seed of SEED) {
      const row = byId.get(seed.id)
      expect(row?.['type']).toBe(seed.type)
      expect(row?.['content']).toBe(seed.content)
      expect(row?.['deleted_at_utc']).toBe(seed.deleted)
      expect(row?.['version']).toBe(seed.version)
      expect(row?.['created_local_date']).toBe('2026-09-30')
    }
    db.close()
  })

  it('新列存在，且老数据一律补成 null', () => {
    const db = migratedDb()
    expect(columns(db, 'records')).toContain('progress')
    expect(columns(db, 'records')).toContain('deadline_local_date')

    const rows = db.prepare('select progress, deadline_local_date from records').all()
    for (const row of rows) {
      expect(row['progress']).toBeNull()
      expect(row['deadline_local_date']).toBeNull()
    }
    db.close()
  })

  it('留底表 records_legacy 已被清掉（不留垃圾）', () => {
    const db = migratedDb()
    expect(names(db, 'table')).not.toContain('records_legacy')
    db.close()
  })
})

describe('迁移后：索引与触发器一个都不能少', () => {
  it('四个索引都还在，且挂在 records 上', () => {
    const db = migratedDb()
    const rows = db
      .prepare("select name, tbl_name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
      .all()
    const map = new Map(rows.map((row) => [String(row['name']), String(row['tbl_name'])]))
    for (const index of [
      'records_user_id_idx',
      'records_user_local_date_idx',
      'records_user_type_idx',
      'records_user_server_updated_idx',
    ]) {
      expect(map.get(index)).toBe('records')
    }
    db.close()
  })

  it('四个触发器都重建了（一个都不能少）', () => {
    const db = migratedDb()
    expect(names(db, 'trigger')).toEqual([
      'applied_mutations_no_rewrite',
      'records_created_fields_immutable',
      'records_no_hard_delete',
      'records_version_must_increase',
    ])
    db.close()
  })
})

describe('★ 迁移后红线依然有效（触发器真的在工作，不是只建了个名字）', () => {
  it('物理删除依然被拒', () => {
    const db = migratedDb()
    expect(() => db.exec("delete from records where id = 'r-idea'")).toThrow(
      /records_must_be_soft_deleted/,
    )
    expect(db.prepare('select count(*) as n from records').get()?.['n']).toBe(SEED.length)
    db.close()
  })

  it('created_at / created_local_date / type 依然改不动', () => {
    const db = migratedDb()
    expect(() =>
      db.exec("update records set created_at_utc = '1999-01-01T00:00:00.000Z', version = 9 where id = 'r-idea'"),
    ).toThrow(/created_fields_are_immutable/)
    expect(() =>
      db.exec("update records set type = 'todo', version = 9 where id = 'r-idea'"),
    ).toThrow(/created_fields_are_immutable/)
    db.close()
  })

  it('version 依然必须单调递增', () => {
    const db = migratedDb()
    expect(() => db.exec("update records set content = 'x', version = 1 where id = 'r-idea'")).toThrow(
      /version_must_increase/,
    )
    // 正常 +1 必须放行 —— 否则就是「把红线做成了拦路虎」
    db.exec("update records set content = 'x', version = 4 where id = 'r-idea'")
    expect(db.prepare("select content from records where id = 'r-idea'").get()?.['content']).toBe('x')
    db.close()
  })
})

describe('迁移后：新能力真的可用', () => {
  it('可以插入 project，并带进度与截止日', () => {
    const db = migratedDb()
    db.prepare(
      `insert into records (
         id, user_id, type, content, progress, deadline_local_date,
         created_at_utc, created_timezone, created_local_date,
         updated_at_utc, updated_timezone,
         completed_at_utc, completed_timezone, deleted_at_utc,
         version, server_updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'r-project',
      'u-1',
      'project',
      '毕业论文',
      60,
      '2026-10-12',
      '2026-10-01T01:00:00.000Z',
      'Asia/Shanghai',
      '2026-10-01',
      '2026-10-01T01:00:00.000Z',
      'Asia/Shanghai',
      null,
      null,
      null,
      1,
      '2026-10-01T01:00:00.000Z',
    )

    const row = db.prepare("select progress, deadline_local_date from records where id = 'r-project'").get()
    expect(row?.['progress']).toBe(60)
    expect(row?.['deadline_local_date']).toBe('2026-10-12')
    db.close()
  })

  it('灵感 / 待办不许带进度和截止日（约束真的在拦）', () => {
    const db = migratedDb()
    expect(() =>
      db.exec(
        "update records set progress = 50, version = 9 where id = 'r-idea'",
      ),
    ).toThrow(/constraint/i)
    expect(() =>
      db.exec(
        "update records set deadline_local_date = '2026-10-12', version = 9 where id = 'r-todo'",
      ),
    ).toThrow(/constraint/i)
    db.close()
  })

  it('进度越界被拒（0–100 之外一律不接受）', () => {
    const db = migratedDb()
    db.exec(
      `insert into records (id, user_id, type, content, progress, created_at_utc,
         created_timezone, created_local_date, updated_at_utc, version, server_updated_at)
       values ('r-p', 'u-1', 'project', 'p', 50, '2026-10-01T00:00:00.000Z',
         'UTC', '2026-10-01', '2026-10-01T00:00:00.000Z', 1, '2026-10-01T00:00:00.000Z')`,
    )
    expect(() => db.exec("update records set progress = 140, version = 2 where id = 'r-p'")).toThrow(
      /constraint/i,
    )
    expect(() => db.exec("update records set progress = -1, version = 2 where id = 'r-p'")).toThrow(
      /constraint/i,
    )
    db.close()
  })
})

describe('★ 迁移结果必须与全新安装逐列一致', () => {
  it('records 的列名、类型、非空、默认值全部相同', () => {
    const migrated = migratedDb()
    const fresh = freshDb()

    const shape = (rows: Record<string, unknown>[]) =>
      rows
        .map((row) => ({
          name: String(row['name']),
          type: String(row['type']),
          notnull: Number(row['notnull']),
          dflt: row['dflt_value'] === null ? null : String(row['dflt_value']),
          pk: Number(row['pk']),
        }))
        .toSorted((a, b) => (a.name < b.name ? -1 : 1))

    expect(shape(migrated.prepare('pragma table_info(records)').all())).toEqual(
      shape(fresh.prepare('pragma table_info(records)').all()),
    )

    fresh.close()
    migrated.close()
  })

  it('触发器定义逐字相同（空白归一后）', () => {
    const migrated = migratedDb()
    const fresh = freshDb()

    const triggers = (db: DatabaseSync) =>
      db
        .prepare("select name, sql from sqlite_master where type = 'trigger' order by name")
        .all()
        .map((row) => [String(row['name']), String(row['sql']).replace(/\s+/g, ' ').trim()])

    expect(triggers(migrated)).toEqual(triggers(fresh))
    expect(triggers(migrated)).toHaveLength(4)

    fresh.close()
    migrated.close()
  })

  it('索引集合与全新安装一致', () => {
    const migrated = migratedDb()
    const fresh = freshDb()
    const indexNames = (db: DatabaseSync) =>
      db
        .prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name")
        .all()
        .map((row) => String(row['name']))

    expect(indexNames(migrated)).toEqual(indexNames(fresh))

    fresh.close()
    migrated.close()
  })
})
