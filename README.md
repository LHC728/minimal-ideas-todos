# 一刻

[![CI](https://github.com/LHC728/yike/actions/workflows/ci.yml/badge.svg)](https://github.com/LHC728/yike/actions/workflows/ci.yml)

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
npm run setup      # 启用 git 提交门禁（跑一次即可）
npm run dev        # 开发（http://localhost:5173）
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览构建产物
npm run verify     # 一键门禁：类型 + Lint + 单元测试
```

开箱即用：**不配置云端也能完整使用**，此时进入「本机模式」，
所有数据保存在浏览器 IndexedDB，离线、断网、飞行模式都正常工作。

> `npm run setup` 只是把 git 的 `core.hooksPath` 指向仓库内的 `.githooks/`，
> 不安装任何依赖。不跑也不影响开发，只是提交前不会自动检查。

想装到手机或 Linux 桌面上用？见 **[部署与安装](#部署与安装)** ——
这一步有个硬性前提，不看会白折腾。

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
                ErrorBoundary
  domain/       record.ts（Record 领域模型）  mutation.ts（同步单元）
  db/           db.ts  recordRepository.ts  outboxRepository.ts
  sync/         SyncEngine PullService ReconcileService PushService
                RealtimeService ConflictService NetworkWatcher syncStatus
  cloud/        CloudAdapter  SupabaseAdapter  cloudConfig  supabaseClient
  auth/         AuthService
  hooks/        useRecords  useSyncStatus  useMediaQuery
  utils/        time  timezone  id
scripts/
  gen-icons.mjs          生成 PWA 图标（手写 PNG 编码）
  check-base.mjs         校验构建产物路径与部署基路径一致
  check-installable.mjs  实测某个地址能否被安装为 PWA（CDP 权威判据）
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
npm run verify    # 类型检查 + Lint + 71 项单元 / 集成测试
npm run test      # 只跑 Vitest
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

## 代码审查

本仓库的质量靠**机制**兜住，不靠记性：

| 层级 | 在哪里 | 内容 |
| --- | --- | --- |
| 提交前 | `.githooks/pre-commit` | `npm run verify`（tsc + oxlint + vitest） |
| 提交信息 | `.githooks/commit-msg` | Conventional Commits 格式 |
| CI | `.github/workflows/ci.yml` | 静态门禁 → 单元测试 → 构建 + E2E |
| 发布 | `.github/workflows/deploy-pages.yml` | 等 CI 全绿 → 子路径构建 → 校验产物路径 → 发布 |

当前基线：**tsc 0 错误 / oxlint 0 warning（222 条规则）/ 71 项单测全绿**。

- 📋 **[代码审查标准与流程](docs/代码审查标准与流程.md)** —— 优先级判据、
  高风险区清单、三级门禁、测试分层策略、审查清单、例外处理
- 🔍 **[基线审计报告](docs/代码审查-基线审计报告.md)** —— 制定标准前做的实测审计，
  含两个实测出的真实缺陷及其修复过程

---

## 部署与安装

### 为什么必须先部署

「装到手机上」有个硬性前提：**浏览器只允许在 HTTPS 或 localhost 下安装 PWA**。

本机跑 `npm run preview` 是 `http://127.0.0.1:4173`，在你自己电脑上算安全上下文；
但手机连过来是 `http://192.168.x.x:4173` —— **不是安全上下文，装不了**。
所以要先把它放到一个真实网址上。功能上局域网访问是能用的，只是没有「安装」入口。

### 部署到 GitHub Pages

一次性设置：

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**
2. push 到 `main`，等 CI 绿、Deploy 绿

网址：**https://lhc728.github.io/yike/**

之后每次 push 到 `main` 都会自动重新发布，不需要手动操作。

> 部署 workflow（`.github/workflows/deploy-pages.yml`）是**等 CI 全绿之后才触发**的
> （用 `workflow_run` 监听 CI 的完成事件），所以线上永远只会是
> 「类型检查 / Lint / 单测 / 构建 / E2E 全过」的那一个提交。
> 它也会检出那次 CI 跑过的**确切提交**，而不是默认分支的最新提交。

### 荣耀手机上安装

1. 用 **Chrome** 打开 https://lhc728.github.io/yike/
2. 先随便记一条，确认能用
3. 浏览器菜单 → **添加到主屏幕** / **安装应用**
4. 主屏上出现「一刻」图标，点开是全屏窗口，看不出是网页
5. 断网试一下 —— 应该照样能记、能看

**建议用 Chrome 而不是系统自带浏览器。** 荣耀的 MagicOS 基于安卓，
PWA 支持本身没问题，但部分机型的自带浏览器会把「添加到主屏幕」藏在很深的菜单里，
或者在「设置 → 应用 → 特殊访问权限」里做限制。菜单里找不到时：

- 换 Chrome / Edge 再试一次（最有效）
- 或直接当普通网页用 —— 功能完全一样，只是没有独立图标、需要每次打开浏览器

装成 PWA 之后的数据仍然存在手机本机（IndexedDB）。
**如果换浏览器或清了浏览器数据，本机记录会丢** —— 想跨设备/防丢，去
[连接云端](#连接云端可选) 把同步打开。

### Linux 上使用

浏览器打开同一个网址即可，功能完整。

想让它像桌面软件那样用（独立窗口 + 应用菜单里有图标 + 离线可用）：

- **Chrome / Edge**：地址栏右侧会出现「安装」图标，点它；
  或菜单 → 「安装一刻」/「作为应用安装」
- **Firefox**：Linux 版 Firefox 不支持安装 PWA，只能用标签页

装完之后它就是应用菜单里的一个普通程序，独立窗口、没有地址栏。

在 Linux 上开发也完全可以（CI 就跑在 `ubuntu-latest` 上）：
`nvm use` 会读仓库里的 `.nvmrc` 装好 Node 22，然后照「快速开始」走。

### 怎么确认线上真的能装

`scripts/check-base.mjs` 只保证路径没写错，**不能保证浏览器愿意把它当应用装**。
权威判据是 CDP 的 `Page.getInstallabilityErrors`：

```bash
node scripts/check-installable.mjs https://lhc728.github.io/yike/
```

它会逐项检查：安全上下文 → manifest 可读且字段完整 → 每个图标真的取得到
→ `start_url` / `scope` 与页面在同一路径下 → Service Worker 已激活并接管页面
→ 最后用 CDP 给出权威结论。全部通过才会打印「可以被安装为 PWA」。

### 本地构建子路径的坑（Windows / Git Bash）

GitHub Pages 是子路径（`/yike/`），构建时要传 base：

```bash
VITE_BASE=/yike/ npm run build
```

但在 **Windows 的 Git Bash** 里，这条命令会被 MSYS 改写 ——
`/yike/` 被当成 Unix 路径转成 `C:/Users/.../yike/`，**构建照样成功，产物却全是坏路径**。
本地要这样跑：

```bash
MSYS_NO_PATHCONV=1 VITE_BASE=/yike/ npm run build
MSYS_NO_PATHCONV=1 npm run check:base -- /yike/
```

Linux / macOS / CI 上没有这个问题。
`vite.config.ts` 和 `check-base.mjs` 都会**拦截被改写的值并直接报错**，
不会静默产出坏产物。

### PWA 技术细节

构建产物包含 `manifest.webmanifest`、`sw.js`、图标与离线 app shell。

- Service Worker **只缓存 app shell**（HTML / CSS / JS / 图标），业务数据一律走 IndexedDB
- manifest 的 `start_url` / `scope` / 图标全部用**相对路径**，
  所以根路径与子路径部署都正确（写成 `/` 的话子路径部署会指向域名根）
- 路由用 HashRouter，刷新 / 直接打开链接不会 404
- 图标由 `npm run icons` 生成（纯 Node 手写 PNG 编码，无额外依赖）
- `uuidv4()` 有三级兜底，非安全上下文（局域网 HTTP）下也能生成 ID

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
