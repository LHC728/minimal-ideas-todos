-- =====================================================================
-- 一刻 — D1 迁移 0003：新增「进展」类型（log）与 parent_id
--
-- ⚠️ 与 0002 一样，这是**需要重建 records 表**的迁移，务必先备份。
--
-- 为什么又要重建表：
--   1. SQLite 的 `alter table add column` **无法修改 CHECK 约束**。
--      老表的约束是 `type in ('idea','todo','project')`，不重建就永远
--      插不进 'log'。
--   2. 老表那条 `check (type = 'project' or (progress is null and
--      deadline_local_date is null))` 也拦住了 log 带进度 —— 而进展
--      恰恰要记「写下这条时的进度」。这条约束改不了，只能重建。
--   3. 顺带把约束**拆细**：拆成三条之后，报错能指出是哪个字段的问题，
--      而一条大 CHECK 只会说「约束失败」，查起来要一行行试。
--
-- 与 0002 的**唯一区别**：搬数据时这次要真的把 progress /
--   deadline_local_date 带过去（0002 那次是新增列，只能补 null；
--   现在线上已经有大事带进度了，丢了这个就是把用户数据弄丢）。
--
-- 执行方式（D1 没有 --dry-run，所以**先备份**）：
--   npx wrangler d1 export yike-sync --remote --output backup.sql
--   npx wrangler d1 execute yike-sync --remote --file=worker/migrations/0003_log_type.sql
--   npx wrangler deploy            ← 缺了这一步，老 Worker 会把 payload 里的
--                                     parentId 当没看见：不报错，但同步不过去
--
-- 本脚本已在本地用真实 SQLite（node:sqlite）在「老库 + 真实数据」上验证过，
-- 见 src/test/d1Migration.test.ts。
-- =====================================================================

-- ---------- 1. 拆掉触发器 ----------
drop trigger if exists records_no_hard_delete;
drop trigger if exists records_created_fields_immutable;
drop trigger if exists records_version_must_increase;

-- ---------- 2. 老表改名留底 ----------
-- 索引跟着表走，此刻 records_user_id_idx 等挂在 records_legacy 上。
-- 所以必须在 drop 掉 records_legacy **之后**才能重建索引 ——
-- 否则 `create index if not exists` 会因重名被静默跳过，
-- 表建好了却一个索引都没有，而且不报任何错。
alter table records rename to records_legacy;

-- ---------- 3. 建新表 ----------
create table records (
  id                  text primary key,
  user_id             text not null,
  type                text not null check (type in ('idea', 'todo', 'project', 'log')),
  content             text not null default '',
  progress            integer check (progress is null or (progress between 0 and 100)),
  deadline_local_date text,
  parent_id           text,
  created_at_utc      text not null,
  created_timezone    text not null default 'UTC',
  created_local_date  text not null,
  updated_at_utc      text not null,
  updated_timezone    text,
  completed_at_utc    text,
  completed_timezone  text,
  deleted_at_utc      text,
  version             integer not null default 1,
  server_updated_at   text not null,
  check (type = 'project' or deadline_local_date is null),
  check (type in ('project', 'log') or progress is null),
  check (type = 'log' or parent_id is null)
);

-- ---------- 4. 搬数据 ----------
-- 逐列写死，不用 `select *` —— 列顺序变了就会静默串列。
-- ⚠️ progress / deadline_local_date 必须原样带过来（大事的进度就在这里）。
--    老数据里不可能有 log，所以 parent_id 一律补 null。
insert into records (
  id, user_id, type, content, progress, deadline_local_date, parent_id,
  created_at_utc, created_timezone, created_local_date,
  updated_at_utc, updated_timezone,
  completed_at_utc, completed_timezone, deleted_at_utc,
  version, server_updated_at
)
select
  id, user_id, type, content, progress, deadline_local_date, null,
  created_at_utc, created_timezone, created_local_date,
  updated_at_utc, updated_timezone,
  completed_at_utc, completed_timezone, deleted_at_utc,
  version, server_updated_at
from records_legacy;

-- ---------- 5. 删掉留底表（老索引随之消失） ----------
drop table records_legacy;

-- ---------- 6. 重建索引 ----------
create index if not exists records_user_id_idx             on records (user_id);
create index if not exists records_user_local_date_idx     on records (user_id, created_local_date);
create index if not exists records_user_type_idx           on records (user_id, type);
create index if not exists records_user_server_updated_idx on records (user_id, server_updated_at);

-- ---------- 7. 重建触发器（与 schema.sql 逐字一致） ----------

drop trigger if exists records_no_hard_delete;
create trigger records_no_hard_delete
before delete on records
for each row
begin
  select raise(abort, 'records_must_be_soft_deleted');
end;

-- 2. 创建时定死的字段永不改变（这次把 parent_id 也钉上）
drop trigger if exists records_created_fields_immutable;
create trigger records_created_fields_immutable
before update on records
for each row
when new.created_at_utc     <> old.created_at_utc
  or new.created_local_date <> old.created_local_date
  or new.created_timezone   <> old.created_timezone
  or new.id                 <> old.id
  or new.user_id            <> old.user_id
  or new.type               <> old.type
  or new.parent_id          <> old.parent_id
begin
  select raise(abort, 'created_fields_are_immutable');
end;

drop trigger if exists records_version_must_increase;
create trigger records_version_must_increase
before update on records
for each row
when new.version <= old.version
begin
  select raise(abort, 'version_must_increase');
end;
