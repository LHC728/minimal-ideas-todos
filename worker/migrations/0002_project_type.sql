-- =====================================================================
-- 一刻 — D1 迁移 0002：新增「大事」类型（project）与进度 / 截止日
--
-- ⚠️ 这是本项目**唯一一次需要重建 records 表**的迁移，务必先备份。
--
-- 为什么必须重建表，而不能只写两条 ALTER：
--   1. SQLite 的 `alter table add column` **无法修改 CHECK 约束**。
--      老表的约束是 `type in ('idea','todo')`，不重建就永远插不进 'project'。
--   2. `worker/schema.sql` 里用的是 `create table if not exists` ——
--      表已存在时整段跳过，改那边的列定义对老库完全不生效。
--      这正是最阴的一处：改完 schema.sql 看着像改好了，线上却毫无变化。
--
-- 为什么把触发器先 drop 掉：
--   `drop table` 本身不激活 DELETE 触发器，但显式 drop 一遍更稳，
--   也顺便避免「重建过程中有人恰好插了一条」这种没法复现的怪事。
--
-- 执行方式（先 --dry-run 不了，D1 没有这个开关，所以**先备份**）：
--   npx wrangler d1 export yike-sync --remote --output backup.sql
--   npx wrangler d1 execute yike-sync --remote --file=worker/migrations/0002_project_type.sql
--
-- 本脚本已在本地用真实 SQLite（node:sqlite）在「老库 + 真实数据」上验证过，
-- 见 src/test/d1Migration.test.ts。
-- =====================================================================

-- ---------- 1. 拆掉触发器 ----------
drop trigger if exists records_no_hard_delete;
drop trigger if exists records_created_fields_immutable;
drop trigger if exists records_version_must_increase;

-- ---------- 2. 老表改名留底 ----------
-- 注意：索引是跟着表走的，`records_user_id_idx` 等此时挂在 records_legacy 上。
-- 所以下面必须在 drop 掉 records_legacy **之后**才能重建索引 ——
-- 否则 `create index if not exists` 会因为重名被静默跳过，
-- 表建好了却一个索引都没有，而且不会报任何错。
alter table records rename to records_legacy;

-- ---------- 3. 建新表 ----------
create table records (
  id                  text primary key,
  user_id             text not null,
  type                text not null check (type in ('idea', 'todo', 'project')),
  content             text not null default '',
  progress            integer check (progress is null or (progress between 0 and 100)),
  deadline_local_date text,
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
  check (type = 'project' or (progress is null and deadline_local_date is null))
);

-- ---------- 4. 搬数据 ----------
-- 逐列写死，不用 `select *` —— 列顺序变了就会静默串列。
-- 已有的记录全是 idea / todo，进度与截止日一律补 null。
insert into records (
  id, user_id, type, content, progress, deadline_local_date,
  created_at_utc, created_timezone, created_local_date,
  updated_at_utc, updated_timezone,
  completed_at_utc, completed_timezone, deleted_at_utc,
  version, server_updated_at
)
select
  id, user_id, type, content, null, null,
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
