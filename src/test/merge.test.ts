/**
 * 三方安全合并单元测试（方案 §48 - §53）。
 *
 * 这是「同步绝不能静默丢数据」的最后一道防线，必须逐字段验证。
 */
import { describe, expect, it } from 'vitest'
import type { RecordSnapshot } from '../domain/record'
import {
  applyConflictChoice,
  diffSnapshot,
  operationForDiff,
  threeWayMerge,
} from '../sync/ConflictService'

function snap(overrides: Partial<RecordSnapshot> = {}): RecordSnapshot {
  return {
    type: 'idea',
    content: 'AAA',
    progress: null,
    deadlineLocalDate: null,
    createdAtUtc: '2026-09-29T16:00:00.000Z',
    createdTimezone: 'Asia/Shanghai',
    createdLocalDate: '2026-09-30',
    updatedAtUtc: '2026-09-29T16:00:00.000Z',
    updatedTimezone: 'Asia/Shanghai',
    completedAtUtc: null,
    completedTimezone: null,
    deletedAtUtc: null,
    ...overrides,
  }
}

describe('不可变字段', () => {
  it('created_* 永远跟随 base，任何一侧都改不动', () => {
    const base = snap()
    const local = snap({ createdLocalDate: '2026-10-05', content: 'BBB' })
    const remote = snap({ createdLocalDate: '2026-10-06', content: 'CCC' })
    const result = threeWayMerge(base, local, remote)
    expect(result.autoMerged.createdLocalDate).toBe('2026-09-30')
    expect(result.merged.createdLocalDate).toBe('2026-09-30')
  })
})

describe('自动合并', () => {
  it('只改不同字段 → 无冲突', () => {
    const base = snap({ type: 'todo', content: '学习 STM32' })
    const local = snap({ type: 'todo', content: '学习 STM32', completedAtUtc: '2026-10-03T08:22:00.000Z' })
    const remote = snap({ type: 'todo', content: '学习 STM32 定时器' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.content).toBe('学习 STM32 定时器')
    expect(result.merged.completedAtUtc).toBe('2026-10-03T08:22:00.000Z')
  })

  it('只有一侧修改 → 采用修改的那一侧', () => {
    const base = snap()
    const local = snap()
    const remote = snap({ content: '远端改的' })
    expect(threeWayMerge(base, local, remote).merged.content).toBe('远端改的')
  })

  it('两侧改成同样的值 → 不算冲突', () => {
    const base = snap()
    const local = snap({ content: '同样的结果' })
    const remote = snap({ content: '同样的结果' })
    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.content).toBe('同样的结果')
  })
})

describe('真冲突', () => {
  it('两侧都改 content 且不同 → 冲突，且不自动选择任何一方', () => {
    const base = snap({ content: '学习 STM32' })
    const local = snap({ content: '学习 STM32 + CAN' })
    const remote = snap({ content: '学习 STM32 定时器' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual(['content'])
    // 冲突字段在 autoMerged 里保持 base 值（未决），由用户裁决
    expect(result.autoMerged.content).toBe('学习 STM32')
    // merged 默认保留本机
    expect(result.merged.content).toBe('学习 STM32 + CAN')
  })

  it('裁决「保留另一设备」时，非冲突字段的自动合并结果仍然保留', () => {
    const base = snap({ type: 'todo', content: 'AAA' })
    const local = snap({ type: 'todo', content: 'BBB', completedAtUtc: '2026-10-03T08:22:00.000Z' })
    const remote = snap({ type: 'todo', content: 'CCC' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual(['content'])

    const withLocal = applyConflictChoice(result, local)
    expect(withLocal.content).toBe('BBB')
    expect(withLocal.completedAtUtc).toBe('2026-10-03T08:22:00.000Z')

    const withRemote = applyConflictChoice(result, remote)
    expect(withRemote.content).toBe('CCC')
    // 本机的完成状态是非冲突字段，选择远端版本时也必须保留
    expect(withRemote.completedAtUtc).toBe('2026-10-03T08:22:00.000Z')
  })
})

describe('删除冲突（§52）', () => {
  it('本机删除、远端改了正文 → 破坏性冲突，不自动决定', () => {
    const base = snap()
    const local = snap({ deletedAtUtc: '2026-09-29T20:00:00.000Z' })
    const remote = snap({ content: '远端编辑过' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toContain('deletedAtUtc')
    expect(result.autoMerged.deletedAtUtc).toBeNull()
  })

  it('远端删除、本机改过 → 同样进入冲突', () => {
    const base = snap()
    const local = snap({ content: '本机编辑过' })
    const remote = snap({ deletedAtUtc: '2026-09-29T20:00:00.000Z' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toContain('deletedAtUtc')
  })

  it('远端删除、本机完全没动 → 安全采用删除，不需要打扰用户', () => {
    const base = snap()
    const local = snap()
    const remote = snap({ deletedAtUtc: '2026-09-29T20:00:00.000Z' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.deletedAtUtc).toBe('2026-09-29T20:00:00.000Z')
  })

  it('两边都删除 → 意图一致，取较早的删除时间', () => {
    const base = snap()
    const local = snap({ deletedAtUtc: '2026-09-29T22:00:00.000Z' })
    const remote = snap({ deletedAtUtc: '2026-09-29T20:00:00.000Z' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.deletedAtUtc).toBe('2026-09-29T20:00:00.000Z')
  })
})

describe('大事（project）的进度与截止日', () => {
  it('只一端改了进度 → 自动合并，不打扰用户', () => {
    const base = snap({ type: 'project', content: '机械臂', progress: 20 })
    const local = snap({ type: 'project', content: '机械臂', progress: 60 })
    const remote = snap({ type: 'project', content: '机械臂', progress: 20 })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.progress).toBe(60)
  })

  it('只一端改了截止日 → 自动合并', () => {
    const base = snap({ type: 'project', content: '机械臂', deadlineLocalDate: null })
    const local = snap({ type: 'project', content: '机械臂', deadlineLocalDate: null })
    const remote = snap({ type: 'project', content: '机械臂', deadlineLocalDate: '2026-10-15' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.deadlineLocalDate).toBe('2026-10-15')
  })

  it('两端都改进度且不同 → 冲突，且 autoMerged 退回 base（不做「取较大值」）', () => {
    // 「取较大值」会把「本机退回 0 重做」抹掉，所以宁可交给用户裁决
    const base = snap({ type: 'project', content: '机械臂', progress: 50 })
    const local = snap({ type: 'project', content: '机械臂', progress: 0 })
    const remote = snap({ type: 'project', content: '机械臂', progress: 80 })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toContain('progress')
    expect(result.autoMerged.progress).toBe(50)
  })

  it('两端都改截止日且不同 → 冲突', () => {
    const base = snap({ type: 'project', content: '机械臂', deadlineLocalDate: '2026-10-01' })
    const local = snap({ type: 'project', content: '机械臂', deadlineLocalDate: '2026-10-10' })
    const remote = snap({ type: 'project', content: '机械臂', deadlineLocalDate: '2026-10-20' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toContain('deadlineLocalDate')
    expect(result.autoMerged.deadlineLocalDate).toBe('2026-10-01')
  })

  it('两端改成同一个进度 → 不算冲突', () => {
    const base = snap({ type: 'project', content: '机械臂', progress: 10 })
    const local = snap({ type: 'project', content: '机械臂', progress: 100 })
    const remote = snap({ type: 'project', content: '机械臂', progress: 100 })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.progress).toBe(100)
  })

  it('一端改正文、另一端改进度 → 两条互不干扰，都保留', () => {
    const base = snap({ type: 'project', content: '机械臂', progress: 10 })
    const local = snap({ type: 'project', content: '机械臂 v2', progress: 10 })
    const remote = snap({ type: 'project', content: '机械臂', progress: 40 })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.merged.content).toBe('机械臂 v2')
    expect(result.merged.progress).toBe(40)
  })

  it('裁决「保留另一设备」时，进度与截止日也一起跟着走', () => {
    const base = snap({ type: 'project', content: '机械臂', progress: 50, deadlineLocalDate: '2026-10-01' })
    const local = snap({ type: 'project', content: '本机写的', progress: 0, deadlineLocalDate: '2026-10-10' })
    const remote = snap({ type: 'project', content: '远端写的', progress: 80, deadlineLocalDate: '2026-10-20' })

    const result = threeWayMerge(base, local, remote)
    expect(result.conflicts).toContain('content')

    expect(applyConflictChoice(result, local).progress).toBe(0)
    expect(applyConflictChoice(result, remote).progress).toBe(80)
    expect(applyConflictChoice(result, remote).deadlineLocalDate).toBe('2026-10-20')
  })

  it('diffSnapshot 会带上进度与截止日的变化', () => {
    const from = snap({ type: 'project', content: '机械臂', progress: 20, deadlineLocalDate: null })
    const to = snap({ type: 'project', content: '机械臂', progress: 60, deadlineLocalDate: '2026-10-15' })
    const patch = diffSnapshot(from, to)
    expect(patch.progress).toBe(60)
    expect(patch.deadlineLocalDate).toBe('2026-10-15')
  })
})

describe('补丁与操作类型', () => {
  it('diffSnapshot 只包含变化字段', () => {
    const from = snap()
    const to = snap({ content: 'BBB', completedAtUtc: '2026-10-03T08:22:00.000Z' })
    const patch = diffSnapshot(from, to)
    expect(patch.content).toBe('BBB')
    expect(patch.completedAtUtc).toBe('2026-10-03T08:22:00.000Z')
    expect('deletedAtUtc' in patch).toBe(false)
  })

  it('operationForDiff 能区分完成 / 取消完成 / 删除 / 恢复', () => {
    const base = snap({ type: 'todo' })
    expect(operationForDiff(base, snap({ type: 'todo', completedAtUtc: '2026-10-03T08:22:00.000Z' }))).toBe('complete')
    expect(operationForDiff(snap({ type: 'todo', completedAtUtc: '2026-10-03T08:22:00.000Z' }), base)).toBe('uncomplete')
    expect(operationForDiff(base, snap({ type: 'todo', deletedAtUtc: '2026-09-29T20:00:00.000Z' }))).toBe('delete')
    expect(operationForDiff(snap({ type: 'todo', deletedAtUtc: '2026-09-29T20:00:00.000Z' }), base)).toBe('restore')
    expect(operationForDiff(base, snap({ type: 'todo', content: 'BBB' }))).toBe('update')
  })
})
