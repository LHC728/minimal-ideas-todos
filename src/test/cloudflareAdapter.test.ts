/**
 * CloudflareAdapter —— 客户端侧的适配器。
 *
 * 这一层是「网络来的脏数据」与「领域层的干净数据」之间的唯一闸门，
 * 所以重点测两件事：
 *   1. 字段归一：网络上任何形状的 JSON 进来，出去都得是合法的 CloudRecord
 *   2. 失败不装成功：非 2xx 必须抛错，绝不能返回一个「看起来应用了」的结果
 *
 * 第 2 条是本项目的命门。同步引擎只要把失败当成成功，
 * outbox 里那条 mutation 就会被删掉 —— 那是真正的数据丢失，且无声无息。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CloudflareAdapter, cloudflareAdapter } from '../cloud/CloudflareAdapter'
import { CloudRequestError } from '../cloud/cloudflareClient'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'

const WORKER_URL = 'https://yike-sync.example.workers.dev'
const TOKEN = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/**
 * 明确写出 fetch 的签名。
 * 交给 `vi.fn` 自己推断的话，一个「没有参数的实现」会被推成 0 元签名，
 * 于是 `toHaveBeenCalledWith(url, init)` 会报「Expected 0 arguments」——
 * 明明调用是对的，类型却在撒谎。
 */
type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>

let adapter: CloudflareAdapter

beforeEach(() => {
  localStorage.clear()
  saveCloudConfig({ provider: 'cloudflare', url: `${WORKER_URL}/` }) // 故意带结尾斜杠
  saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: 'a@example.com' })
  adapter = new CloudflareAdapter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 装一个假的 fetch，返回给定的 JSON */
function stubFetch(payload: unknown, init: { status?: number } = {}): FetchMock {
  const status = init.status ?? 200
  const mock: FetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}

// =====================================================================
describe('是否已配置', () => {
  it('地址与令牌都齐了才算配置好', () => {
    expect(adapter.isConfigured()).toBe(true)
  })

  it('没配地址 → 未配置', () => {
    localStorage.clear()
    saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: null })
    expect(adapter.isConfigured()).toBe(false)
  })

  it('没登录（没有令牌）→ 未配置', () => {
    localStorage.clear()
    saveCloudConfig({ provider: 'cloudflare', url: WORKER_URL })
    expect(adapter.isConfigured()).toBe(false)
  })

  it('配置的是 Supabase 时，Cloudflare 适配器不认（两套配置不串台）', () => {
    localStorage.clear()
    saveCloudConfig({ provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'key' })
    saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: null })
    expect(adapter.isConfigured()).toBe(false)
  })
})

describe('请求怎么发出去', () => {
  it('地址结尾的斜杠被去掉，路径不重复', async () => {
    const mock = stubFetch({ records: [] })
    await adapter.pullAll('user-a')
    expect(mock).toHaveBeenCalledWith(
      `${WORKER_URL}/api/sync/pull`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('带上 Bearer 令牌', async () => {
    const mock = stubFetch({ records: [] })
    await adapter.pullAll('user-a')
    const headers = (mock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined
    expect(headers?.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('recordId 会做 URL 编码', async () => {
    const mock = stubFetch({ record: null })
    await adapter.pullOne('user-a', 'a/b?c=d&e')
    expect(mock.mock.calls[0]?.[0]).toBe(
      `${WORKER_URL}/api/sync/record?id=${encodeURIComponent('a/b?c=d&e')}`,
    )
  })

  it('没配置就调用 → 立刻报错，不发请求', async () => {
    localStorage.clear()
    const mock = stubFetch({ records: [] })
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_not_configured')
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('pullAll 的字段归一', () => {
  it('完整的一行原样映射（含大事的进度与截止日）', async () => {
    stubFetch({
      records: [
        {
          id: 'r-1',
          userId: 'user-a',
          type: 'project',
          content: '毕业论文',
          progress: 40,
          deadlineLocalDate: '2026-10-12',
          createdAtUtc: '2026-09-30T01:00:00.000Z',
          createdTimezone: 'Asia/Shanghai',
          createdLocalDate: '2026-09-30',
          updatedAtUtc: '2026-09-30T01:00:00.000Z',
          updatedTimezone: 'Asia/Shanghai',
          completedAtUtc: null,
          completedTimezone: null,
          deletedAtUtc: null,
          version: 3,
          serverUpdatedAt: '2026-09-30T02:00:00.000Z',
        },
      ],
    })

    expect(await adapter.pullAll('user-a')).toEqual([
      {
        id: 'r-1',
        userId: 'user-a',
        type: 'project',
        content: '毕业论文',
        progress: 40,
        deadlineLocalDate: '2026-10-12',
        createdAtUtc: '2026-09-30T01:00:00.000Z',
        createdTimezone: 'Asia/Shanghai',
        createdLocalDate: '2026-09-30',
        updatedAtUtc: '2026-09-30T01:00:00.000Z',
        updatedTimezone: 'Asia/Shanghai',
        completedAtUtc: null,
        completedTimezone: null,
        deletedAtUtc: null,
        version: 3,
        serverUpdatedAt: '2026-09-30T02:00:00.000Z',
      },
    ])
  })

  it('缺字段的老记录：进度与截止日补成 null，不是 undefined', async () => {
    // 关键：必须是 null 而不是 undefined。
    // snapshotEquals 用的是严格相等，undefined ≠ null 会在下一次同步时
    // 凭空造出一个「删除冲突」弹窗（Dexie v2 迁移存在的全部理由）。
    stubFetch({ records: [{ id: 'r-1', type: 'idea', version: 1 }] })
    const [record] = await adapter.pullAll('user-a')
    expect(record?.progress).toBeNull()
    expect(record?.deadlineLocalDate).toBeNull()
    expect(record?.progress).not.toBeUndefined()
  })

  it('越界的进度与畸形的截止日在入口被收敛掉', async () => {
    stubFetch({
      records: [
        { id: 'r-1', type: 'project', version: 1, progress: 999, deadlineLocalDate: '2026-13-45' },
        { id: 'r-2', type: 'project', version: 1, progress: 'abc', deadlineLocalDate: '' },
      ],
    })
    const [first, second] = await adapter.pullAll('user-a')
    expect(first?.progress).toBe(100) // 夹到 0–100
    expect(first?.deadlineLocalDate).toBeNull() // 13 月 45 日不是真日期
    expect(second?.progress).toBeNull()
    expect(second?.deadlineLocalDate).toBeNull()
  })

  it('字段缺失 / 类型不对时不抛异常，而是给出安全值', async () => {
    stubFetch({
      records: [
        {
          // 缺 id / content / 各种时间
          type: 'garbage',
          version: 'not-a-number',
          createdTimezone: null,
          updatedTimezone: undefined,
        },
      ],
    })

    const [record] = await adapter.pullAll('user-a')
    expect(record).toBeDefined()
    expect(record?.id).toBe('')
    expect(record?.type).toBe('idea') // 只认 todo，其他一律 idea
    expect(record?.content).toBe('')
    expect(record?.version).toBe(1) // 非法版本号退回 1，不能是 NaN
    expect(record?.createdTimezone).toBe('UTC')
    expect(record?.updatedTimezone).toBe('UTC')
    expect(record?.completedAtUtc).toBeNull()
    expect(record?.deletedAtUtc).toBeNull()
    // 绝不能出现 NaN —— 它会让后续的版本比较永远为 false
    expect(Number.isNaN(record?.version)).toBe(false)
  })

  it('空字符串的时间字段当成 null，不留下 "" 这种半吊子值', async () => {
    stubFetch({
      records: [
        { id: 'r-1', type: 'idea', completedAtUtc: '', completedTimezone: '', deletedAtUtc: '' },
      ],
    })
    const [record] = await adapter.pullAll('user-a')
    expect(record?.completedAtUtc).toBeNull()
    expect(record?.deletedAtUtc).toBeNull()
  })

  it('响应里没有 records 字段 → 空数组，而不是崩掉', async () => {
    stubFetch({})
    expect(await adapter.pullAll('user-a')).toEqual([])
  })

  it('records 是 null → 空数组', async () => {
    stubFetch({ records: null })
    expect(await adapter.pullAll('user-a')).toEqual([])
  })
})

describe('pullOne', () => {
  it('有记录就返回，字段照样归一', async () => {
    stubFetch({ record: { id: 'r-1', type: 'todo', version: 2 } })
    const record = await adapter.pullOne('user-a', 'r-1')
    expect(record?.id).toBe('r-1')
    expect(record?.type).toBe('todo')
    expect(record?.version).toBe(2)
  })

  it('record 为 null → 返回 null（表示「服务端没这条」，不是「请求失败」）', async () => {
    stubFetch({ record: null })
    expect(await adapter.pullOne('user-a', 'r-1')).toBeNull()
  })
})

describe('applyMutation 的状态透传', () => {
  const params = {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create' as const,
    expectedVersion: null,
    payload: { content: 'x' },
  }

  it('把请求参数原样送到后端', async () => {
    const mock = stubFetch({ status: 'applied', version: 1, record: null })
    await adapter.applyMutation('user-a', params)

    const body = JSON.parse(String((mock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as
      Record<string, unknown>
    expect(body).toEqual({
      mutationId: 'm-1',
      recordId: 'r-1',
      operation: 'create',
      expectedVersion: null,
      payload: { content: 'x' },
    })
  })

  for (const status of ['applied', 'already_applied', 'version_conflict', 'record_not_found'] as const) {
    it(`${status} 原样透传`, async () => {
      stubFetch({ status, version: 2, record: null })
      const result = await adapter.applyMutation('user-a', params)
      expect(result.status).toBe(status)
      expect(result.version).toBe(2)
    })
  }

  it('后端返回了没见过的 status → 保守当成 applied（只有后端明确说冲突才当冲突）', async () => {
    stubFetch({ status: 'weird_new_status', version: 1, record: null })
    expect((await adapter.applyMutation('user-a', params)).status).toBe('applied')
  })

  it('version 是字符串时转成数字，null 保持 null', async () => {
    stubFetch({ status: 'applied', version: '7', record: null })
    expect((await adapter.applyMutation('user-a', params)).version).toBe(7)

    stubFetch({ status: 'record_not_found', version: null, record: null })
    expect((await adapter.applyMutation('user-a', params)).version).toBeNull()
  })

  it('record 存在时也归一', async () => {
    stubFetch({ status: 'applied', version: 1, record: { id: 'r-1', type: 'garbage', version: 1 } })
    const result = await adapter.applyMutation('user-a', params)
    expect(result.record?.id).toBe('r-1')
    expect(result.record?.type).toBe('idea')
  })
})

describe('★ 失败绝不装成成功', () => {
  const params = {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create' as const,
    expectedVersion: null,
    payload: {},
  }

  for (const status of [400, 401, 403, 404, 500, 502]) {
    it(`${status} → 抛 CloudRequestError 且带上状态码`, async () => {
      stubFetch({ error: 'nope' }, { status })
      const error = await adapter.applyMutation('user-a', params).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(CloudRequestError)
      expect((error as CloudRequestError).status).toBe(status)
    })
  }

  it('401 能被识别出来（AuthService 靠它判断「令牌失效」）', async () => {
    stubFetch({ error: 'unauthorized' }, { status: 401 })
    const error = await adapter.pullAll('user-a').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CloudRequestError)
    expect((error as CloudRequestError).status).toBe(401)
  })

  it('响应体不是 JSON 也能拿到状态码（例如网关的错误页）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    )
    const error = await adapter.pullAll('user-a').catch((thrown: unknown) => thrown)
    expect((error as CloudRequestError).status).toBe(502)
  })

  it('断网（fetch 直接 reject）→ 原样抛出，不吞掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(adapter.pullAll('user-a')).rejects.toThrow('Failed to fetch')
  })
})

describe('subscribe', () => {
  it('Worker 没有推送通道，返回一个可调用的空取消函数', () => {
    const unsubscribe = adapter.subscribe('user-a', () => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })

  it('kind 是 cloudflare —— 同步引擎据此判断能力差异', () => {
    expect(cloudflareAdapter.kind).toBe('cloudflare')
  })
})
