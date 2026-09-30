# 一刻

> 想到的那一刻，就记下来。

极简、本地优先、跨设备同步的「灵感 + 待办 + 时间线」工具。

只解决两件事：

1. 我突然想到一个东西 → 立即记下来。
2. 我突然想到一件要做的事 → 立即记下来，并可以完成它。

核心体验：**想到 → 写下 → 继续做自己的事情。**

---

## 快速开始

```bash
npm install
npm run dev        # 开发（http://localhost:5173）
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览构建产物
```

开箱即用：**不配置云端也能完整使用**，此时进入「本机模式」，
所有数据保存在浏览器 IndexedDB，离线、断网、飞行模式都正常工作。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite |
| UI | Tailwind CSS v4 + Lucide |
| 本地数据库 | IndexedDB（Dexie 4） |
| PWA | vite-plugin-pwa（Workbox） |
| 云 | Supabase Auth + PostgreSQL + Realtime |
| 测试 | Vitest + Playwright |

---

## 目录结构

```
src/
  app/          router / AppShell / uiStore / navItems
  pages/        HomePage  IdeasPage  CalendarPage  TodosPage  LoginPage
  components/   QuickCapture RecordRow RecordNode CompletedTodoRow RecordDetail
                TodoCheckbox DateGroup MonthCalendar BottomNav DesktopSidebar
                SyncIndicator ConflictDialog SearchPanel SettingsSheet Modal Toaster
  domain/       record.ts（Record 领域模型）  mutation.ts（同步单元）
  db/           db.ts  recordRepository.ts  outboxRepository.ts
  sync/         SyncEngine PullService ReconcileService PushService
                RealtimeService ConflictService NetworkWatcher syncStatus
  cloud/        CloudAdapter  SupabaseAdapter  cloudConfig  supabaseClient
  auth/         AuthService
  hooks/        useRecords  useSyncStatus  useMediaQuery
  utils/        time  timezone  id
```

依赖方向（严格单向）：

```
UI → Repository / Domain → IndexedDB → SyncEngine → CloudAdapter → Supabase
```

React 页面不直接调用 Supabase。

---

## 核心数据理念

整个 APP 只有一种核心数据：`Record`。

```
灵感 = Record(type = "idea")
待办 = Record(type = "todo")
```

四个页面只是对同一份数据的不同观察方式：

| 页面 | 语义 | 过滤条件 |
| --- | --- | --- |
| 首页 | 我什么时候记下了什么（时间线） | `deleted_at = null` |
| 灵感 | 只显示灵感 | `type = idea AND deleted_at = null` |
| 待办 | 现在还有什么没做 | `type = todo AND completed_at = null AND deleted_at = null` |
| 日历 | 我在某一天想到了什么 | 按 `created_local_date` 归档 |

待办页底部另有一块默认折叠的「已完成」区，按 `completed_at` 倒序。
它不是归档（归档归首页时间线管），而是一块**后悔药** ——
打勾这个动作太轻，手滑一下那条就从列表里没了，所以任何时候都能从那里撤销。

导航顺序：首页 / 灵感 / 待办 / 日历。

**时间贯穿整个 APP**：首页 / 灵感 / 待办显示 `HH:mm` 与日期分组，
详情显示 `YYYY年MM月DD日 HH:mm`，日历通过 `created_local_date` 查询。

### 时间字段互不混用

| 字段 | 含义 | 会不会被改写 |
| --- | --- | --- |
| `created_at_utc` / `created_timezone` / `created_local_date` | 第一次写下的那一刻 | **永不改变** |
| `updated_at_utc` / `updated_timezone` | 最后一次编辑 | 只在编辑正文时更新 |
| `completed_at_utc` / `completed_timezone` | 完成时间 | 打勾时写入 |
| `deleted_at_utc` | 软删除时间 | 删除时写入 |
| `server_updated_at` | 服务器同步时间 | 只用于同步，绝不覆盖用户记录时间 |

即使离线 4 小时才同步，创建时间仍然是用户当时写下的那一刻。

---

## 同步设计

### 顺序：Pull → Reconcile → Push → Pull

绝不使用简单的 `Push → Pull`，也绝不使用 Last Write Wins。

1. **Pull**：拉取该用户全部 Record（含软删除 Tombstone）
2. **Reconcile**：对齐服务器与本机状态
   - 本机没有未同步修改 → 采用服务器
   - 本机有修改、服务器没动 → 保留本机，准备 Push
   - 两边都动了 → 三方比较（`Base` / `Local` / `Remote`）
3. **Push**：把本机改动送上去
4. **再 Pull**：应用服务器返回结果并补齐遗漏

### 可靠性机制

- **Version + 乐观并发**：每条 Record 带 `version`，每次成功变化 +1
- **原子检查**：数据库端 `apply_record_mutation` RPC 在同一个事务里完成
  「检查 version → 应用 mutation → version + 1 → 记录 applied_mutations」
- **幂等**：每个 Mutation 带 `mutationId`，服务端 `applied_mutations` 保证
  重试不会重复执行（响应包丢失后重试是安全的）
- **同 Record 串行**：同一条记录一次只发送一个 Mutation；不同 Record 可并行
- **离线压缩**：离线连续修改 5 次只发 1 个 Update，`baseServerVersion` /
  `baseSnapshot` 仍保留最初那一份
- **Realtime 只是加速器**：漏事件不影响最终一致性，Pull 一定能补回来
- **软删除永久保留**：V1 不做 Tombstone GC，最可靠地防止「离线设备复活已删除记录」

### 冲突处理

只有**真正冲突**时才打扰用户：

| 场景 | 处理 |
| --- | --- |
| 一边改正文、一边完成 Todo | 自动安全合并，不打扰用户 |
| 两边都改同一字段且内容不同 | 弹出冲突，展示本机版本 / 另一设备版本 |
| 一边删除、一边编辑 | 破坏性冲突，提示「保留删除」/「恢复并保留本机内容」 |

用户完成选择以前，`Base` / `Local` / `Remote` 三个版本一个都不会丢。

---

## 连接云端（可选）

### 1. 建表

在 Supabase 项目的 SQL Editor 中执行：

```
supabase/migrations/0001_init.sql
```

脚本会创建 `records` / `applied_mutations` 两张表、四个索引、
`apply_record_mutation` RPC，并开启 RLS：

- 用户只能 `SELECT` / `INSERT` / `UPDATE` 自己的数据（`user_id = auth.uid()`）
- **故意不创建 DELETE 策略** → 物理删除在数据库层面被彻底禁止

### 2. 配置连接

方式一：构建期环境变量

```bash
cp .env.example .env
# 填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run build
```

方式二：运行期在 APP 内填写

打开右上角「设置 → 云端连接」，粘贴 Supabase URL 与 anon key 并保存。

### 3. 登录

已配置云端时，首次使用要求登录（邮箱验证码 / Magic Link）。
从本机模式首次登录时，本机已有记录会自动归入该账号，不会丢失。

---

## 测试

```bash
npm test          # Vitest：62 项单元 / 集成测试
npm run test:e2e  # Playwright：24 项 E2E（桌面 12 + 手机 12）
```

E2E 跑的是构建产物，所以要先构建：

```bash
npm run build
npm run test:e2e
```

如果 E2E 在收尾阶段卡住不动（Playwright 自行关闭 preview 服务时可能发生），
先在另一个终端常驻服务，再跑测试 —— 配置里 `reuseExistingServer: true`
会直接复用它，不再需要关闭：

```bash
npm run preview    # 终端 A，保持运行
npm run test:e2e   # 终端 B
```

### Vitest 覆盖（方案 §77）

| 编号 | 场景 |
| --- | --- |
| Test 1 | 离线创建，刷新后仍存在 |
| Test 2 | 离线 Todo 创建 + 完成，刷新后状态正确 |
| Test 3 | 离线补同步，另一台设备能看到 |
| Test 4 | 响应丢失后重试，服务端只发生一次逻辑修改 |
| Test 5 | Realtime：A 创建，B 不刷新自动看到 |
| Test 6 | 漏掉 Realtime，Pull 也能补回来 |
| Test 7 | 同时修改同一字段 → 必须进入冲突 |
| Test 8 | 修改不同字段 → 自动安全合并 |
| Test 9 | 删除防复活 |
| Test 10 | 删除与编辑冲突 |
| Test 11 | 创建时间不可改变 |
| Test 12 | 完成不改变归档日 |
| Test 13 | 编辑后重新打开 |
| Test 14 | 账号隔离 |

多设备通过 `FakeCloudServer`（内存版，行为与 `0001_init.sql` 完全一致）
+ 切换独立 IndexedDB 顺序模拟。

---

## PWA

构建产物包含 `manifest.webmanifest`、`sw.js`、图标与离线 app shell。

- 荣耀 / Android 手机浏览器可正常使用，可「添加到桌面」
- Windows / Linux 浏览器可正常使用，可安装为 Web App
- 普通浏览器直接访问仍然完整可用

Service Worker **只缓存 app shell**（HTML / CSS / JS / 图标），
业务数据一律走 IndexedDB。

图标由 `npm run icons` 生成（纯 Node 手写 PNG 编码，无额外依赖）。

---

## V1 边界

不做：标签、文件夹、多级分类、优先级、截止日期、提醒、闹钟、周期任务、
子任务、看板、甘特图、Markdown、富文本、图片、附件、录音、AI、RAG、
番茄钟、习惯打卡、数据统计、社交、团队协作。

V1 不做计划时间：`scheduled_at` 留给未来，且绝不会复用 `created_at`。

判断标准：它有没有让「想到 → 写下」更快？它是不是灵感 / 待办 / 时间真正必要的一部分？

---

## 数据安全优先级

```
数据不丢 > 时间正确 > 离线正常 > 同步正确 > 冲突正确 > 基本交互 > UI 美观 > 动画
```

界面可以朴素，但绝不能丢记录、重复创建、静默覆盖、改变创建时间、
让删除记录复活，或让离线时无法写入。

---

## 许可证

[MIT](LICENSE) © 2026 LHC728

可以自由使用、修改、分发，包括用于闭源商业产品，只需保留版权声明。
