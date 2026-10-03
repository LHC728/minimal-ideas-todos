/**
 * 云端 Schema 与安全规则静态校验（方案 §32、§40、§41、§64）。
 *
 * 这些是不可退让的底线，用断言把它们钉住，
 * 避免以后有人改 SQL 时悄悄把 RLS 或幂等去掉。
 *
 * ⚠️ 读的是 **0001 + 0002 拼起来的有效 SQL**，不是只读 0001。
 * 0002 用 `create or replace function` 重新定义了 apply_record_mutation，
 * 只读 0001 等于在检查一份**已经被覆盖掉的旧定义** —— 断言全绿，
 * 而线上跑的却是另一份代码。这种「测了个寂寞」比没有测试更危险。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8').toLowerCase()
}

const migration0001 = read('supabase/migrations/0001_init.sql')
const migration0002 = read('supabase/migrations/0002_project_type.sql')

/** 按应用顺序拼接：后面的定义覆盖前面的 */
const sql = `${migration0001}\n${migration0002}`

describe('records 表结构', () => {
  it('包含方案要求的全部字段', () => {
    for (const column of [
      'id                 uuid primary key',
      'user_id            uuid not null',
      'type               text not null',
      'content            text not null',
      'created_at_utc     timestamptz not null',
      'created_timezone   text not null',
      'created_local_date date not null',
      'updated_at_utc     timestamptz not null',
      'updated_timezone   text',
      'completed_at_utc   timestamptz',
      'completed_timezone text',
      'deleted_at_utc     timestamptz',
      'version            bigint not null',
      'server_updated_at  timestamptz not null',
    ]) {
      expect(sql).toContain(column)
    }
  })

  it('四个索引都在', () => {
    expect(sql).toContain('records_user_id_idx')
    expect(sql).toContain('records_user_local_date_idx')
    expect(sql).toContain('records_user_type_idx')
    expect(sql).toContain('records_user_server_updated_idx')
  })
})

describe('applied_mutations（幂等，§41、§42）', () => {
  it('mutation_id 是主键', () => {
    expect(sql).toContain('mutation_id    uuid primary key')
  })

  it('RPC 首先检查 mutation_id 是否已经应用', () => {
    expect(sql).toContain('from public.applied_mutations')
    expect(sql).toContain("'already_applied'")
  })

  it('并发重放不会重复写入', () => {
    expect(sql).toContain('on conflict (mutation_id) do nothing')
  })
})

describe('原子 version 检查（§40）', () => {
  it('用 SELECT ... FOR UPDATE 锁定行，杜绝先查后写', () => {
    expect(sql).toContain('for update')
  })

  it('期望版本不匹配时返回 version_conflict 而不是覆盖', () => {
    expect(sql).toContain('p_expected_version')
    expect(sql).toContain("'version_conflict'")
  })

  it('成功时 version 原子 +1', () => {
    expect(sql).toContain('version            = version + 1')
  })

  it('暴露为一个 RPC，客户端不直接 UPDATE', () => {
    expect(sql).toContain('create or replace function public.apply_record_mutation')
  })
})

describe('RLS（§64）', () => {
  it('records 与 applied_mutations 都开启行级安全', () => {
    expect(sql).toContain('alter table public.records enable row level security')
    expect(sql).toContain('alter table public.applied_mutations enable row level security')
  })

  it('所有策略都以 user_id = auth.uid() 为条件', () => {
    const policies = sql.match(/create policy [\s\S]*?;/g) ?? []
    expect(policies.length).toBeGreaterThanOrEqual(5)
    for (const policy of policies) {
      expect(policy).toContain('auth.uid()')
    }
  })

  it('故意不提供 DELETE 策略 → 物理删除被彻底禁止', () => {
    expect(sql).not.toMatch(/create policy [a-z_]+ on public\.records\s+for delete/)
    expect(sql).not.toContain('for delete')
  })
})

describe('服务器时间不覆盖用户时间（§11）', () => {
  it('**每一版** RPC 的 UPDATE 都不碰 created_at_utc / created_local_date', () => {
    // 0002 重新定义了 apply_record_mutation，所以每一处 UPDATE 都要检查。
    // 只看第一处的话，新版本里混进 created_at_utc 就整个漏掉了。
    const parts = sql.split('update public.records').slice(1)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const part of parts) {
      const end = part.indexOf('returning * into v_row')
      const updateSet = end === -1 ? part : part.slice(0, end)
      expect(updateSet).not.toContain('created_at_utc')
      expect(updateSet).not.toContain('created_local_date')
    }
  })
})

describe('迁移 0002：大事（project）', () => {
  it('放宽 type 约束到三种', () => {
    expect(migration0002).toContain("check (type in ('idea', 'todo', 'project'))")
  })

  it('新增两列，且用 if not exists（迁移可重复执行）', () => {
    expect(migration0002).toContain(
      'alter table public.records add column if not exists progress integer',
    )
    expect(migration0002).toContain(
      'alter table public.records add column if not exists deadline_local_date date',
    )
  })

  it('截止日存的是 date，不是 timestamptz —— 免疫时区漂移', () => {
    expect(migration0002).toContain('deadline_local_date date')
    expect(migration0002).not.toContain('deadline_local_date timestamptz')
  })

  it('约束用 drop ... if exists 再 add，重复执行不报错', () => {
    for (const name of [
      'records_type_check',
      'records_progress_range',
      'records_project_fields_only',
    ]) {
      expect(migration0002).toContain(`drop constraint if exists ${name}`)
    }
  })

  it('0002 不许碰 RLS —— 迁移只加字段，不动安全边界', () => {
    expect(migration0002).not.toContain('row level security')
    expect(migration0002).not.toContain('create policy')
  })

  it('新版 RPC 依然保留全部红线', () => {
    const fn = migration0002.slice(migration0002.indexOf('create or replace function'))
    expect(fn).toContain('for update')
    expect(fn).toContain("'version_conflict'")
    expect(fn).toContain('version            = version + 1')
    expect(fn).toContain('on conflict (mutation_id) do nothing')
    expect(fn).toContain("'already_applied'")
    expect(fn).toContain('not_authenticated')
  })

  it('非大事的 progress / deadline 在两端入口都被丢弃', () => {
    // 插入路径按 type 判断
    expect(migration0002).toContain("coalesce(p_payload ->> 'type', 'idea') = 'project'")
    // 更新路径按当前行的 type 判断（type 不可变，所以等价且更快）
    expect(migration0002).toContain("v_row.type = 'project'")
  })
})
