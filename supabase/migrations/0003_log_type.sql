-- =====================================================================
-- 一刻 — Supabase 迁移 0003：新增「进展」类型（log）与 parent_id
--
-- 与 worker/migrations/0003_log_type.sql 语义完全等价。
-- 两套后端可以互换，客户端不应该感知到差别。
--
-- 与 D1 那边的关键差别：Postgres 支持 `add column if not exists` 和
-- `drop constraint if exists`，所以**不需要重建表**，也不会有停机窗口。
--
-- 应用方式：Supabase 控制台 → SQL Editor → 整段粘贴执行。
-- ⚠️ SQL Editor 把整批当一个事务：任何一条报错，前面建好的全部回滚。
-- =====================================================================

-- ---------- 1. 放宽 type 约束，允许第四种类型 ----------
alter table public.records drop constraint if exists records_type_check;
alter table public.records add constraint records_type_check
  check (type in ('idea', 'todo', 'project', 'log'));

-- ---------- 2. 新列 ----------
-- parent_id：进展所属大事的 id。只有 log 才有值。
--   刻意不加外键约束：大事是**软删除**的，行永远还在，外键不会挡住任何
--   正常操作，却会在「先建进展、后同步到大事」这种合法的乱序到达场景下
--   把同步卡死。与 D1 那边的行为保持一致（那边也没有外键）。
alter table public.records add column if not exists parent_id uuid;

-- ---------- 3. 约束（把产品红线钉在数据库上） ----------
-- 0002 那条「非大事不许有进度和截止日」要拆开：进展要能带进度。
-- 拆成三条之后报错能指出是哪个字段的问题，而一条大 CHECK 只会说
-- 「约束失败」，查起来要一行行试。
alter table public.records drop constraint if exists records_project_fields_only;

alter table public.records drop constraint if exists records_deadline_project_only;
alter table public.records add constraint records_deadline_project_only
  check (type = 'project' or deadline_local_date is null);

alter table public.records drop constraint if exists records_progress_project_or_log;
alter table public.records add constraint records_progress_project_or_log
  check (type in ('project', 'log') or progress is null);

alter table public.records drop constraint if exists records_parent_log_only;
alter table public.records add constraint records_parent_log_only
  check (type = 'log' or parent_id is null);

-- ---------- 4. 更新 apply_record_mutation ----------
-- 相对 0002 版改了三件事：
--   建表时写入 parent_id；progress 放宽到 project / log 两类；
--   更新时同样放宽 progress，且**不接受** parent_id（它是不可变字段，
--   与 D1 那边的触发器语义一致）。
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
      id, user_id, type, content, progress, deadline_local_date, parent_id,
      created_at_utc, created_timezone, created_local_date,
      updated_at_utc, updated_timezone,
      completed_at_utc, completed_timezone, deleted_at_utc,
      version, server_updated_at
    ) values (
      p_record_id,
      v_uid,
      coalesce(p_payload ->> 'type', 'idea'),
      coalesce(p_payload ->> 'content', ''),
      -- 进度属于大事和进展；截止日只属于大事；parent_id 只属于进展。
      -- 与客户端 createRecord 的行为一致，也是上面那三条 CHECK
      -- 能一直成立的前提。
      case when coalesce(p_payload ->> 'type', 'idea') in ('project', 'log')
           then (p_payload ->> 'progress')::int
           else null
      end,
      case when coalesce(p_payload ->> 'type', 'idea') = 'project'
           then (p_payload ->> 'deadlineLocalDate')::date
           else null
      end,
      -- nullif 挡掉空字符串：`''::uuid` 会直接抛错，
      -- 而空字符串在语义上就等于「没有父级」。
      case when coalesce(p_payload ->> 'type', 'idea') = 'log'
           then nullif(p_payload ->> 'parentId', '')::uuid
           else null
      end,
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
           -- type 在触发器里是不可变的，所以用当前行的 type 判断即可。
           -- parent_id 刻意不出现在 SET 里：它是不可变字段。
           progress           = case
                                  when v_row.type in ('project', 'log') and p_payload ? 'progress'
                                  then (p_payload ->> 'progress')::int
                                  else progress
                                end,
           deadline_local_date = case
                                  when v_row.type = 'project' and p_payload ? 'deadlineLocalDate'
                                  then (p_payload ->> 'deadlineLocalDate')::date
                                  else deadline_local_date
                                end,
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
