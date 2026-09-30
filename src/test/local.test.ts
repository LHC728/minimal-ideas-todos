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
} from '../db/recordRepository'
import { listAllPending } from '../db/outboxRepository'
import { groupByLocalDate, byCompletedAtDesc, isDoneTodo, isOpenTodo, isOnTimeline } from '../domain/record'
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
