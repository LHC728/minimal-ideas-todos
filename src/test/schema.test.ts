/**
 * 云端 Schema 与安全规则静态校验（方案 §32、§40、§41、§64）。
 *
 * 这些是不可退让的底线，用断言把它们钉住，
 * 避免以后有人改 SQL 时悄悄把 RLS 或幂等去掉。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0001_init.sql'),
  'utf8',
).toLowerCase()

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
  it('created_at_utc 只在 INSERT 时写入，UPDATE 语句里不出现', () => {
    const updateStatement = sql.slice(sql.indexOf('update public.records'))
    const updateSet = updateStatement.slice(0, updateStatement.indexOf('returning * into v_row'))
    expect(updateSet).not.toContain('created_at_utc')
    expect(updateSet).not.toContain('created_local_date')
  })
})
