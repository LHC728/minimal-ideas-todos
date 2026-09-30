-- =====================================================================
-- 极简灵感与待办 APP — Supabase 初始化脚本（方案 §32、§40、§41、§64）
--
-- 设计要点：
--   1. records 只有软删除，物理 DELETE 被 RLS 彻底禁止
--   2. version 在数据库端原子 +1，绝不允许「先 SELECT 再 UPDATE」
--   3. applied_mutations 保证同步重试幂等
--   4. RLS 保证用户只能访问自己的数据
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- records
-- ---------------------------------------------------------------
create table if not exists public.records (
  id                 uuid primary key,
  user_id            uuid not null references auth.users (id) on delete cascade,
  type               text not null check (type in ('idea', 'todo')),
  content            text not null default '',
  created_at_utc     timestamptz not null,
  created_timezone   text not null default 'UTC',
  created_local_date date not null,
  updated_at_utc     timestamptz not null,
  updated_timezone   text,
  completed_at_utc   timestamptz,
  completed_timezone text,
  deleted_at_utc     timestamptz,
  version            bigint not null default 1,
  server_updated_at  timestamptz not null default now()
);

create index if not exists records_user_id_idx            on public.records (user_id);
create index if not exists records_user_local_date_idx    on public.records (user_id, created_local_date);
create index if not exists records_user_type_idx          on public.records (user_id, type);
create index if not exists records_user_server_updated_idx on public.records (user_id, server_updated_at);

-- ---------------------------------------------------------------
-- applied_mutations（幂等）
-- ---------------------------------------------------------------
create table if not exists public.applied_mutations (
  mutation_id    uuid primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  record_id      uuid not null,
  result_version bigint not null,
  applied_at     timestamptz not null default now()
);

create index if not exists applied_mutations_user_idx on public.applied_mutations (user_id);
create index if not exists applied_mutations_record_idx on public.applied_mutations (record_id);

-- ---------------------------------------------------------------
-- 触发器：任何直接 UPDATE 也保证 version 单调递增、server_updated_at 刷新
-- （RPC 里已经显式 +1，这里不会重复自增）
-- ---------------------------------------------------------------
create or replace function public.records_touch()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.version = old.version then
      new.version := old.version + 1;
    end if;
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists records_touch_trigger on public.records;
create trigger records_touch_trigger
  before insert or update on public.records
  for each row execute function public.records_touch();

-- ---------------------------------------------------------------
-- 原子应用一次 Mutation
--   检查 version + 应用 mutation + version + 1 + 记录 applied_mutations
--   全部在同一个事务里完成，杜绝竞态（§40）
-- ---------------------------------------------------------------
create or replace function public.apply_record_mutation(
  p_mutation_id      uuid,
  p_record_id        uuid,
  p_operation        text,
  p_expected_version bigint,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid          uuid := auth.uid();
  v_row          public.records%rowtype;
  v_existing     bigint;
  v_new_version  bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- 幂等：同一个 mutationId 只允许生效一次（§41、§42）
  select result_version into v_existing
    from public.applied_mutations
   where mutation_id = p_mutation_id
     and user_id = v_uid;

  if found then
    select * into v_row from public.records
     where id = p_record_id and user_id = v_uid;
    return jsonb_build_object(
      'status', 'already_applied',
      'version', coalesce(v_row.version, v_existing),
      'record', case when v_row.id is null then null else to_jsonb(v_row) end
    );
  end if;

  -- 锁定该行，保证 version 检查与写入原子（§40）
  select * into v_row from public.records
   where id = p_record_id and user_id = v_uid
   for update;

  if not found then
    if p_operation <> 'create' then
      return jsonb_build_object('status', 'record_not_found', 'version', null, 'record', null);
    end if;

    insert into public.records (
      id, user_id, type, content,
      created_at_utc, created_timezone, created_local_date,
      updated_at_utc, updated_timezone,
      completed_at_utc, completed_timezone, deleted_at_utc,
      version, server_updated_at
    ) values (
      p_record_id,
      v_uid,
      coalesce(p_payload ->> 'type', 'idea'),
      coalesce(p_payload ->> 'content', ''),
      coalesce((p_payload ->> 'createdAtUtc')::timestamptz, now()),
      coalesce(p_payload ->> 'createdTimezone', 'UTC'),
      coalesce((p_payload ->> 'createdLocalDate')::date, (now() at time zone 'UTC')::date),
      coalesce((p_payload ->> 'updatedAtUtc')::timestamptz, now()),
      p_payload ->> 'updatedTimezone',
      (p_payload ->> 'completedAtUtc')::timestamptz,
      p_payload ->> 'completedTimezone',
      (p_payload ->> 'deletedAtUtc')::timestamptz,
      1,
      now()
    )
    returning * into v_row;

    v_new_version := v_row.version;

  else
    -- 乐观并发控制：期望版本与当前版本不一致 → 交给客户端做三方比较
    if p_expected_version is null or p_expected_version <> v_row.version then
      return jsonb_build_object(
        'status', 'version_conflict',
        'version', v_row.version,
        'record', to_jsonb(v_row)
      );
    end if;

    update public.records
       set content            = coalesce(p_payload ->> 'content', content),
           updated_at_utc     = coalesce((p_payload ->> 'updatedAtUtc')::timestamptz, updated_at_utc),
           updated_timezone   = coalesce(p_payload ->> 'updatedTimezone', updated_timezone),
           completed_at_utc   = case
                                  when p_payload ? 'completedAtUtc'
                                  then (p_payload ->> 'completedAtUtc')::timestamptz
                                  else completed_at_utc
                                end,
           completed_timezone = case
                                  when p_payload ? 'completedTimezone'
                                  then p_payload ->> 'completedTimezone'
                                  else completed_timezone
                                end,
           deleted_at_utc     = case
                                  when p_payload ? 'deletedAtUtc'
                                  then (p_payload ->> 'deletedAtUtc')::timestamptz
                                  else deleted_at_utc
                                end,
           version            = version + 1,
           server_updated_at  = now()
     where id = p_record_id and user_id = v_uid
     returning * into v_row;

    v_new_version := v_row.version;
  end if;

  insert into public.applied_mutations (mutation_id, user_id, record_id, result_version)
  values (p_mutation_id, v_uid, p_record_id, v_new_version)
  on conflict (mutation_id) do nothing;

  return jsonb_build_object(
    'status', 'applied',
    'version', v_new_version,
    'record', to_jsonb(v_row)
  );
end;
$$;

-- ---------------------------------------------------------------
-- RLS（§64）：用户只能 SELECT / INSERT / UPDATE 自己的数据
-- 故意不创建 DELETE 策略 → 任何物理删除都会被拒绝
-- ---------------------------------------------------------------
alter table public.records enable row level security;
alter table public.applied_mutations enable row level security;

drop policy if exists records_select_own on public.records;
create policy records_select_own on public.records
  for select using (user_id = auth.uid());

drop policy if exists records_insert_own on public.records;
create policy records_insert_own on public.records
  for insert with check (user_id = auth.uid());

drop policy if exists records_update_own on public.records;
create policy records_update_own on public.records
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists applied_mutations_select_own on public.applied_mutations;
create policy applied_mutations_select_own on public.applied_mutations
  for select using (user_id = auth.uid());

drop policy if exists applied_mutations_insert_own on public.applied_mutations;
create policy applied_mutations_insert_own on public.applied_mutations
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------
-- Realtime（§54）：只作为加速器
-- ---------------------------------------------------------------
alter publication supabase_realtime add table public.records;
