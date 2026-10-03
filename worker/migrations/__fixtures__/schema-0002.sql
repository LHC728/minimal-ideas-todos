-- =====================================================================
-- ⚠️ 冻结副本 —— 这是**迁移 0002 跑完之后**的完整表结构（当时 worker/schema.sql
--    的原样），只作为 src/test/d1Migration.test.ts 的输入存在。
--
--    它是历史事实，**永远不要跟着 worker/schema.sql 一起改**。
--    改了就等于「拿新表结构去测新表结构」，那个测试会彻底失去意义 ——
--    而它保护的正是本项目唯一一类「写漏了也不报错」的迁移。
-- =====================================================================
-- 一刻 — Cloudflare D1 初始化脚本
--
-- 语义必须与 supabase/migrations/0001_init.sql 完全等价。
-- 两套后端可以互换，客户端的同步引擎不应该感知到差别。
--
-- 设计要点（对应项目红线）：
--   1. records 只有软删除 —— 用触发器把物理 DELETE 直接禁掉
--   2. created_at / created_local_date / created_timezone 永不改变 —— 触发器钉死
--   3. version 单调递增 —— 任何不让 version 变大的 UPDATE 直接中止
--   4. applied_mutations 保证同步重试幂等
--   5. 令牌只存 SHA-256，不存明文 —— 库被看到也无法反推出令牌
--
-- 为什么把红线写成触发器而不是只写在文档里：
--   文档靠人记，触发器不靠。将来任何人（包括我）写错一条 SQL，
--   数据库会直接拒绝，而不是悄悄破坏「创建时间不变」这条承诺。
--
-- 应用方式：
--   npx wrangler d1 execute yike-sync --remote --file=worker/schema.sql
-- =====================================================================

-- ---------------------------------------------------------------
-- users
-- ---------------------------------------------------------------
create table if not exists users (
  id         text primary key,
  email      text,
  created_at text not null
);

-- ---------------------------------------------------------------
-- access_tokens
--   token_hash 是令牌的 SHA-256 十六进制串。
--   明文只在生成时出现一次（打印给用户），之后无法从库里取回。
-- ---------------------------------------------------------------
create table if not exists access_tokens (
  token_hash text primary key,
  user_id    text not null references users (id) on delete cascade,
  label      text,
  created_at text not null,
  revoked_at text
);

create index if not exists access_tokens_user_idx on access_tokens (user_id);

-- ---------------------------------------------------------------
-- records
--   时间字段统一存 ISO-8601 UTC 字符串（形如 2026-09-30T13:45:00.000Z）。
--   定长同格式的 ISO 字符串，字典序等于时间序 —— 所以可以直接
--   ORDER BY server_updated_at，不需要额外处理。
--
--   ⚠️ 本文件只对**全新的库**一次到位。
--   线上已有数据的库必须走 worker/migrations/0002_project_type.sql ——
--   `create table if not exists` 遇到已存在的表会整段跳过，
--   改这里的列定义对老库**完全不生效**，而且 type 的 CHECK 约束
--   只能靠重建表才能改。这是本项目最容易踩空的一处。
-- ---------------------------------------------------------------
create table if not exists records (
  id                 text primary key,
  user_id            text not null,
  type               text not null check (type in ('idea', 'todo', 'project')),
  content            text not null default '',
  -- 大事的推进进度，0–100 的整数。灵感 / 待办恒为 null。
  progress           integer check (progress is null or (progress between 0 and 100)),
  -- 大事的截止日，纯日期 YYYY-MM-DD（不是时刻，不带时区）
  deadline_local_date text,
  created_at_utc     text not null,
  created_timezone   text not null default 'UTC',
  created_local_date text not null,
  updated_at_utc     text not null,
  updated_timezone   text,
  completed_at_utc   text,
  completed_timezone text,
  deleted_at_utc     text,
  version            integer not null default 1,
  server_updated_at  text not null,
  -- 进度和截止日只属于大事。灵感 / 待办带着这两个字段是**逻辑上不可能**的，
  -- 与其在读取端到处写防御性分支，不如让数据库直接拒绝。
  check (type = 'project' or (progress is null and deadline_local_date is null))
);

create index if not exists records_user_id_idx             on records (user_id);
create index if not exists records_user_local_date_idx     on records (user_id, created_local_date);
create index if not exists records_user_type_idx           on records (user_id, type);
create index if not exists records_user_server_updated_idx on records (user_id, server_updated_at);

-- ---------------------------------------------------------------
-- applied_mutations（幂等）
--   与「记录写入」在同一个 batch（同一事务）里写入，所以只要
--   result_version 落了库，就说明那次写入真的发生了 —— 两者不会半截生效。
--
--   判据是 SQLite 的 changes()：上一条 INSERT/UPDATE 实际改动的行数。
--   不用 `where exists (...)` 之类的间接判断，因为并发的另一次写入
--   可能刚好造出满足条件的行，从而把「其实没写成功」误记成「已应用」。
-- ---------------------------------------------------------------
create table if not exists applied_mutations (
  mutation_id    text primary key,
  user_id        text not null,
  record_id      text not null,
  result_version integer not null,
  applied_at     text not null
);

create index if not exists applied_mutations_user_idx   on applied_mutations (user_id);
create index if not exists applied_mutations_record_idx on applied_mutations (record_id);

-- ===============================================================
-- 触发器：把产品红线变成数据库约束
-- ===============================================================

-- 1. 禁止物理删除 —— 删除必须是软删除（写 deleted_at_utc）
drop trigger if exists records_no_hard_delete;
create trigger records_no_hard_delete
before delete on records
for each row
begin
  select raise(abort, 'records_must_be_soft_deleted');
end;

-- 2. 创建时间永不改变
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

-- 3. version 必须单调递增
drop trigger if exists records_version_must_increase;
create trigger records_version_must_increase
before update on records
for each row
when new.version <= old.version
begin
  select raise(abort, 'version_must_increase');
end;

-- 4. 幂等记录一旦落定就不许改写 ——
--    重试只能「读到」，不能「改掉」上一次的结果
drop trigger if exists applied_mutations_no_rewrite;
create trigger applied_mutations_no_rewrite
before update on applied_mutations
for each row
when old.result_version > 0
begin
  select raise(abort, 'mutation_result_is_final');
end;
