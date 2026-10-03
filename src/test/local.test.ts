/**
 * 本地优先（Local First）测试 —— 方案 §77 Test 1 / 2 / 11 / 12 / 13。
 * 完全不接云，验证「断网也能用、刷新不丢、时间正确」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../db/db'
import { db } from '../db/db'
import {
  completeTodo,
  createRecord,
  restoreRecord,
  softDelete,
  uncompleteTodo,
  updateContent,
  updateDeadline,
  updateProjectProgress,
} from '../db/recordRepository'
import { listAllPending } from '../db/outboxRepository'
import {
  byDeadlineAsc,
  clampDeadlineLocalDate,
  clampProgress,
  groupByLocalDate,
  byCompletedAtDesc,
  isDoneTodo,
  isOpenProject,
  isOpenTodo,
  isOnTimeline,
} from '../domain/record'
import { cleanupDevices, reopenDevice, openDevice } from './fakeCloudServer'

const USER = 'user-local'
const TZ = 'Asia/Shanghai'

let device: AppDatabase

beforeEach(async () => {
  device = await openDevice(`local-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => {
  await cleanupDevices()
})

describe('Test 1：离线创建', () => {
  it('断网创建 Idea，刷新后仍然存在', async () => {
    await createRecord({
      userId: USER,
      type: 'idea',
      content: '以后可以研究机器人 Agent',
      nowUtc: '2026-09-29T16:43:00.000Z',
      timezone: TZ,
    })

    // 模拟浏览器刷新：关闭再打开同一个 IndexedDB
    await reopenDevice(device)

    const records = await db.records.toArray()
    expect(records).toHaveLength(1)
    expect(records[0]?.content).toBe('以后可以研究机器人 Agent')
    expect(records[0]?.type).toBe('idea')
    expect(records[0]?.syncState).toBe('pending')
  })

  it('创建不产生任何网络依赖：Record 与 Outbox 在同一个事务里落盘', async () => {
    await createRecord({
      userId: USER,
      type: 'idea',
      content: '做一个自己的极简 APP',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.operation).toBe('create')
    expect(pending[0]?.baseServerVersion).toBeNull()
  })
})

describe('Test 2：离线 Todo', () => {
  it('断网创建并完成 Todo，刷新后状态仍然正确', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '学习 STM32 定时器',
      nowUtc: '2026-09-29T16:38:00.000Z',
      timezone: TZ,
    })

    await completeTodo(todo.id, '2026-10-02T08:22:00.000Z', TZ)

    await reopenDevice(device)

    const after = await db.records.get(todo.id)
    expect(after?.completedAtUtc).toBe('2026-10-02T08:22:00.000Z')
    expect(after?.completedTimezone).toBe(TZ)
    expect(after && isOpenTodo(after)).toBe(false)
    // 完成 ≠ 删除
    expect(after?.deletedAtUtc).toBeNull()
  })

  it('取消完成后重新回到待办', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '整理智能车资料',
      nowUtc: '2026-09-29T16:31:00.000Z',
      timezone: TZ,
    })
    await completeTodo(todo.id, '2026-10-02T08:00:00.000Z', TZ)
    await uncompleteTodo(todo.id, '2026-10-02T08:05:00.000Z', TZ)

    const after = await db.records.get(todo.id)
    expect(after?.completedAtUtc).toBeNull()
    expect(after && isOpenTodo(after)).toBe(true)
  })

  it('软删除后不会真正消失，可以撤销', async () => {
    const idea = await createRecord({
      userId: USER,
      type: 'idea',
      content: '机械臂项目也许可以',
      nowUtc: '2026-09-29T14:51:00.000Z',
      timezone: TZ,
    })

    await softDelete(idea.id, '2026-09-30T02:00:00.000Z')
    let after = await db.records.get(idea.id)
    expect(after?.deletedAtUtc).not.toBeNull()
    expect(after && isOnTimeline(after)).toBe(false)
    // 数据库里这一行仍然存在
    expect(await db.records.count()).toBe(1)

    await restoreRecord(idea.id, '2026-09-30T02:00:10.000Z', TZ)
    after = await db.records.get(idea.id)
    expect(after?.deletedAtUtc).toBeNull()
  })
})

describe('待办页「已完成」区（撤销误打勾）', () => {
  it('打勾后进入「已完成」，关闭浏览器再打开依然在，撤销后回到待办', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '给打印机换墨盒',
      nowUtc: '2026-09-30T01:00:00.000Z',
      timezone: TZ,
    })

    await completeTodo(todo.id, '2026-09-30T02:00:00.000Z', TZ)
    let after = await db.records.get(todo.id)
    expect(after && isOpenTodo(after)).toBe(false)
    expect(after && isDoneTodo(after)).toBe(true)
    // 打勾不能动创建时间 —— 撤销之后它还得回到原来的时间位置
    expect(after?.createdAtUtc).toBe('2026-09-30T01:00:00.000Z')

    // 「已完成」区靠的是落盘状态，不是内存里的提示 —— 关掉浏览器再开仍然可撤销
    await reopenDevice(device)
    after = await db.records.get(todo.id)
    expect(after && isDoneTodo(after)).toBe(true)

    await uncompleteTodo(todo.id, '2026-09-30T02:05:00.000Z', TZ)
    after = await db.records.get(todo.id)
    expect(after?.completedAtUtc).toBeNull()
    expect(after && isOpenTodo(after)).toBe(true)
    expect(after?.createdAtUtc).toBe('2026-09-30T01:00:00.000Z')
  })

  it('「已完成」按完成时间倒序，刚打勾的排最前', async () => {
    const first = await createRecord({
      userId: USER,
      type: 'todo',
      content: '先完成的',
      nowUtc: '2026-09-30T01:00:00.000Z',
      timezone: TZ,
    })
    const second = await createRecord({
      userId: USER,
      type: 'todo',
      content: '后完成的',
      nowUtc: '2026-09-30T01:10:00.000Z',
      timezone: TZ,
    })

    await completeTodo(second.id, '2026-09-30T02:00:00.000Z', TZ)
    await completeTodo(first.id, '2026-09-30T03:00:00.000Z', TZ)

    const records = await db.records.where('userId').equals(USER).toArray()
    const done = records.filter(isDoneTodo).toSorted(byCompletedAtDesc)

    expect(done.map((r) => r.content)).toEqual(['先完成的', '后完成的'])
  })
})

describe('Test 11：创建时间不可改变', () => {
  it('9 月 30 日创建、10 月 2 日修改，仍然归档在 9 月 30 日', async () => {
    const idea = await createRecord({
      userId: USER,
      type: 'idea',
      content: '以后研究机器人 Agent',
      nowUtc: '2026-09-29T16:43:00.000Z', // 上海时间 2026-09-30 00:43
      timezone: TZ,
    })

    expect(idea.createdLocalDate).toBe('2026-09-30')
    expect(idea.createdAtUtc).toBe('2026-09-29T16:43:00.000Z')

    await updateContent(idea.id, '以后研究机器人 Agent（补充）', '2026-10-02T10:12:00.000Z', TZ)

    const after = await db.records.get(idea.id)
    expect(after?.createdAtUtc).toBe('2026-09-29T16:43:00.000Z')
    expect(after?.createdLocalDate).toBe('2026-09-30')
    expect(after?.content).toBe('以后研究机器人 Agent（补充）')
    // 最后编辑时间独立
    expect(after?.updatedAtUtc).toBe('2026-10-02T10:12:00.000Z')
  })

  it('完成 Todo 也不会改变创建时间', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '学习 STM32 定时器',
      nowUtc: '2026-09-29T16:38:00.000Z',
      timezone: TZ,
    })
    await completeTodo(todo.id, '2026-10-03T08:22:00.000Z', TZ)

    const after = await db.records.get(todo.id)
    expect(after?.createdAtUtc).toBe('2026-09-29T16:38:00.000Z')
    expect(after?.createdLocalDate).toBe('2026-09-30')
  })
})

describe('Test 12：完成不改变归档日', () => {
  it('9 月 30 日创建的 Todo 在 10 月 3 日完成，日历上仍属于 9 月 30 日', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '学习 STM32 定时器',
      nowUtc: '2026-09-29T16:38:00.000Z',
      timezone: TZ,
    })
    await completeTodo(todo.id, '2026-10-03T08:22:00.000Z', TZ)

    const all = await db.records.where('userId').equals(USER).toArray()
    const onSep30 = all.filter((r) => r.deletedAtUtc === null && r.createdLocalDate === '2026-09-30')
    const onOct3 = all.filter((r) => r.createdLocalDate === '2026-10-03')

    expect(onSep30.map((r) => r.id)).toEqual([todo.id])
    expect(onOct3).toHaveLength(0)

    const detail = onSep30[0]
    expect(detail?.completedAtUtc).toBe('2026-10-03T08:22:00.000Z')
  })
})

describe('Test 13：编辑后重新打开', () => {
  it('编辑内容、完全关闭浏览器、重新打开后修改仍在', async () => {
    const idea = await createRecord({
      userId: USER,
      type: 'idea',
      content: '做一个自己的极简 APP',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    await updateContent(idea.id, '做一个自己的极简 Local First APP', '2026-09-30T03:00:00.000Z', TZ)

    await reopenDevice(device)
    await reopenDevice(device)

    const after = await db.records.get(idea.id)
    expect(after?.content).toBe('做一个自己的极简 Local First APP')
  })
})

describe('时间线排序与分组', () => {
  it('首页按创建时间倒序，同一天归入同一组', async () => {
    await createRecord({ userId: USER, type: 'idea', content: 'A', nowUtc: '2026-09-29T16:14:00.000Z', timezone: TZ })
    await createRecord({ userId: USER, type: 'todo', content: 'B', nowUtc: '2026-09-29T16:38:00.000Z', timezone: TZ })
    await createRecord({ userId: USER, type: 'idea', content: 'C', nowUtc: '2026-09-29T16:43:00.000Z', timezone: TZ })

    const records = await db.records.where('userId').equals(USER).toArray()
    const groups = groupByLocalDate(records.filter(isOnTimeline))

    expect(groups).toHaveLength(1)
    expect(groups[0]?.date).toBe('2026-09-30')
    expect(groups[0]?.items.map((r) => r.content)).toEqual(['C', 'B', 'A'])
  })

  it('离线连续编辑只压缩成一个待发送 Mutation', async () => {
    const idea = await createRecord({
      userId: USER,
      type: 'idea',
      content: '第一版',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    for (let i = 0; i < 5; i += 1) {
      await updateContent(idea.id, `第 ${i + 2} 版`, `2026-09-30T0${i}:00:00.000Z`, TZ)
    }

    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    // create 链路保持 create 语义，payload 收敛为最终状态
    expect(pending[0]?.operation).toBe('create')
    expect(pending[0]?.payload.content).toBe('第 6 版')
    expect(pending[0]?.baseServerVersion).toBeNull()
  })
})

/**
 * 大事（project）—— Record 的第三种类型。
 *
 * 这里要锁死三件事：
 *   1. 只有大事才带进度 / 截止日；灵感与待办即使调用方传了值也一律丢弃
 *   2. 进度与截止日改动都会走 outbox（离线也要能改）
 *   3. 收敛函数不许把畸形输入放进库里（否则界面会出现 width: NaN%）
 */
describe('大事：进度与截止日', () => {
  it('创建大事时带进度与截止日', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      progress: 30,
      deadlineLocalDate: '2026-10-15',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    expect(project.type).toBe('project')
    expect(project.progress).toBe(30)
    expect(project.deadlineLocalDate).toBe('2026-10-15')
    expect(project.completedAtUtc).toBeNull()
  })

  it('创建大事不给进度时默认 0，截止日默认 null', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '还没想好截止日',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    expect(project.progress).toBe(0)
    expect(project.deadlineLocalDate).toBeNull()
  })

  it('灵感 / 待办即使传了进度和截止日也一律丢弃', async () => {
    const idea = await createRecord({
      userId: USER,
      type: 'idea',
      content: '随手记的想法',
      progress: 80,
      deadlineLocalDate: '2026-10-15',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '买螺丝刀',
      progress: 80,
      deadlineLocalDate: '2026-10-15',
      nowUtc: '2026-09-29T16:20:00.000Z',
      timezone: TZ,
    })

    expect(idea.progress).toBeNull()
    expect(idea.deadlineLocalDate).toBeNull()
    expect(todo.progress).toBeNull()
    expect(todo.deadlineLocalDate).toBeNull()
  })

  it('改进度：落库 + 进 outbox（离线也能改），且 payload 里真的带着 progress', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    const updated = await updateProjectProgress(project.id, 60, '2026-09-30T03:00:00.000Z', TZ)
    expect(updated?.progress).toBe(60)

    // ⚠️ 这一环最容易漏：库里改了、但 mutation 的 payload 没带上 progress 的话，
    // 推送出去后端收不到，本机看着 60%、另一台设备拉下来是 0%，而且**不报错**。
    //
    // 注意这里只剩 1 条 mutation —— 尚未发送的 create 和随后的 update 会被
    // 压缩成一条（§58），operation 取优先级更高的那个，也就是 create。
    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.operation).toBe('create')
    expect(pending[0]?.payload.progress).toBe(60)
    expect(pending[0]?.payload.updatedAtUtc).toBe('2026-09-30T03:00:00.000Z')

    // 刷新后仍在
    await reopenDevice(device)
    const after = await db.records.get(project.id)
    expect(after?.progress).toBe(60)
    expect(after?.updatedAtUtc).toBe('2026-09-30T03:00:00.000Z')
  })

  it('改进度到相同的值 → 不产生多余的写（幂等）', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      progress: 40,
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    const again = await updateProjectProgress(project.id, 40, '2026-09-30T03:00:00.000Z', TZ)
    expect(again?.progress).toBe(40)
    expect(again?.updatedAtUtc).toBe('2026-09-29T16:14:00.000Z') // 没被改
  })

  it('设截止日 → 进 outbox payload', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    const set = await updateDeadline(project.id, '2026-10-15', '2026-09-30T03:00:00.000Z', TZ)
    expect(set?.deadlineLocalDate).toBe('2026-10-15')

    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.payload.deadlineLocalDate).toBe('2026-10-15')
  })

  it('清除截止日 → payload 里必须是显式 null，不能是「这个字段没带」', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      deadlineLocalDate: '2026-10-15',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    const cleared = await updateDeadline(project.id, null, '2026-09-30T04:00:00.000Z', TZ)
    expect(cleared?.deadlineLocalDate).toBeNull()

    // 后端把「字段没带」理解成「这一列不改」，所以清除必须显式带 null 出去，
    // 否则本地清掉了、云端还留着，下一次 Pull 又给拉回来。
    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    expect('deadlineLocalDate' in (pending[0]?.payload ?? {})).toBe(true)
    expect(pending[0]?.payload.deadlineLocalDate).toBeNull()
  })

  it('对灵感 / 待办调用改进度或改截止日 → 字段一动不动，也不产生多余的 mutation', async () => {
    const todo = await createRecord({
      userId: USER,
      type: 'todo',
      content: '买螺丝刀',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    // commitChange 的契约是「没有变化就返回原记录（而不是 null）」，
    // 这里断言的是**字段没被动过**，而不是返回值形状。
    const afterProgress = await updateProjectProgress(todo.id, 50, '2026-09-30T03:00:00.000Z', TZ)
    expect(afterProgress?.progress).toBeNull()

    const afterDeadline = await updateDeadline(todo.id, '2026-10-15', '2026-09-30T03:00:00.000Z', TZ)
    expect(afterDeadline?.deadlineLocalDate).toBeNull()

    const after = await db.records.get(todo.id)
    expect(after?.progress).toBeNull()
    expect(after?.deadlineLocalDate).toBeNull()
    // 只有创建时那一条 mutation，没有多出 update
    const pending = await listAllPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.operation).toBe('create')
  })

  it('进度越界会被收敛进 0..100，畸形输入不会进库', async () => {
    const project = await createRecord({
      userId: USER,
      type: 'project',
      content: '做一个机械臂',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })

    expect((await updateProjectProgress(project.id, 999, '2026-09-30T03:00:00.000Z', TZ))?.progress).toBe(100)
    expect((await updateProjectProgress(project.id, -20, '2026-09-30T04:00:00.000Z', TZ))?.progress).toBe(0)
    // NaN / 非数字 → 拒绝，保持原值
    expect(await updateProjectProgress(project.id, Number.NaN, '2026-09-30T05:00:00.000Z', TZ)).toBeNull()
  })

  it('clampProgress / clampDeadlineLocalDate 的边界行为', () => {
    expect(clampProgress(50)).toBe(50)
    expect(clampProgress(150)).toBe(100)
    expect(clampProgress(-5)).toBe(0)
    expect(clampProgress(33.6)).toBe(34) // 四舍五入成整数
    expect(clampProgress(null)).toBeNull()
    expect(clampProgress(undefined)).toBeNull()
    expect(clampProgress('')).toBeNull()
    expect(clampProgress('abc')).toBeNull()
    expect(clampProgress(Number.NaN)).toBeNull()
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBeNull()

    expect(clampDeadlineLocalDate('2026-10-15')).toBe('2026-10-15')
    expect(clampDeadlineLocalDate(null)).toBeNull()
    expect(clampDeadlineLocalDate('')).toBeNull()
    expect(clampDeadlineLocalDate('2026-02-30')).toBeNull() // 2 月没有 30 日
    expect(clampDeadlineLocalDate('2026-13-01')).toBeNull()
    expect(clampDeadlineLocalDate(123)).toBeNull()
  })

  it('isOpenProject：100% 或已删除的不算「在做」', async () => {
    const doing = await createRecord({
      userId: USER,
      type: 'project',
      content: '进行中的',
      progress: 40,
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })
    const finished = await createRecord({
      userId: USER,
      type: 'project',
      content: '做完的',
      progress: 100,
      nowUtc: '2026-09-29T16:20:00.000Z',
      timezone: TZ,
    })
    const deleted = await createRecord({
      userId: USER,
      type: 'project',
      content: '删掉的',
      progress: 10,
      nowUtc: '2026-09-29T16:30:00.000Z',
      timezone: TZ,
    })
    await softDelete(deleted.id, '2026-09-30T03:00:00.000Z')

    // 软删后要重新读一次 —— 内存里那个对象还是删除前的快照
    const deletedAfter = await db.records.get(deleted.id)

    expect(isOpenProject(doing)).toBe(true)
    expect(isOpenProject(finished)).toBe(false)
    expect(deletedAfter).toBeDefined()
    expect(isOpenProject(deletedAfter as NonNullable<typeof deletedAfter>)).toBe(false)
  })

  it('byDeadlineAsc：有截止日的排前面且按日期升序，没截止日的排最后', async () => {
    const noDeadline = await createRecord({
      userId: USER,
      type: 'project',
      content: '没有截止日',
      nowUtc: '2026-09-29T16:14:00.000Z',
      timezone: TZ,
    })
    const late = await createRecord({
      userId: USER,
      type: 'project',
      content: '晚一点',
      deadlineLocalDate: '2026-10-20',
      nowUtc: '2026-09-29T16:20:00.000Z',
      timezone: TZ,
    })
    const soon = await createRecord({
      userId: USER,
      type: 'project',
      content: '快到了',
      deadlineLocalDate: '2026-10-05',
      nowUtc: '2026-09-29T16:30:00.000Z',
      timezone: TZ,
    })

    const sorted = [noDeadline, late, soon].toSorted(byDeadlineAsc)
    expect(sorted.map((r) => r.content)).toEqual(['快到了', '晚一点', '没有截止日'])
  })
})
