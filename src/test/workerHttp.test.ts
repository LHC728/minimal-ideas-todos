// @vitest-environment node
/**
 * Cloudflare Worker 的 HTTP 层（worker/src/index.ts）。
 *
 * core.ts 测的是「逻辑对不对」，这里测的是「接口这一圈有没有漏」：
 *   - 该拦的拦住了吗（401 / 400 / 404）
 *   - 出错时会不会返回一个**看起来成功**的响应（这是最危险的）
 *   - 跨账号能不能越界
 *   - 客户端拿到的 JSON 形状是否稳定
 *
 * 用真实的 Request/Response（Node 内置），直接把请求交给 worker.fetch，
 * 不经过任何网络 —— 这样测的是真正的入口函数，不是它的仿制品。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/src/index'
import type { Env } from '../../worker/src/core'
import { createSqliteD1, seedUser, type SqliteD1 } from './sqliteD1'

const USER_A = 'user-a'
const USER_B = 'user-b'
const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const BASE = 'https://yike-sync.example.workers.dev'

let db: SqliteD1

beforeEach(async () => {
  db = createSqliteD1()
  await seedUser(db, { userId: USER_A, email: 'a@example.com', token: TOKEN_A })
  await seedUser(db, { userId: USER_B, email: null, token: TOKEN_B })
})

function call(
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; rawBody?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined && options.token !== null) {
    headers.Authorization = `Bearer ${options.token}`
  }
  if (options.origin !== undefined) headers.Origin = options.origin

  const init: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.rawBody !== undefined) init.body = options.rawBody
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  return worker.fetch(new Request(`${BASE}${path}`, init), { DB: db } satisfies Env)
}

/** 一个完整的 create 请求体 */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create',
    expectedVersion: null,
    payload: {
      type: 'idea',
      content: '想到的那一刻',
      createdAtUtc: '2026-09-30T01:00:00.000Z',
      createdTimezone: 'Asia/Shanghai',
      createdLocalDate: '2026-09-30',
      updatedAtUtc: '2026-09-30T01:00:00.000Z',
      updatedTimezone: 'Asia/Shanghai',
    },
    ...overrides,
  }
}

// =====================================================================
describe('健康检查与预检', () => {
  it('GET /api/health 不需要令牌', async () => {
    const response = await call('/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, service: 'yike-sync' })
  })

  it('OPTIONS 预检返回 204 且带齐 CORS 头', async () => {
    const response = await call('/api/sync/pull', { method: 'OPTIONS', origin: 'https://lhc728.github.io' })
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('authorization')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('ALLOWED_ORIGINS 收紧后只回白名单里的来源', async () => {
    const env: Env = { DB: db, ALLOWED_ORIGINS: 'https://lhc728.github.io, https://other.example' }

    const allowed = await worker.fetch(
      new Request(`${BASE}/api/health`, { headers: { Origin: 'https://lhc728.github.io' } }),
      env,
    )
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://lhc728.github.io')

    const stranger = await worker.fetch(
      new Request(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example' } }),
      env,
    )
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBe('https://lhc728.github.io')
  })
})

describe('鉴权', () => {
  it('不带令牌 → 401', async () => {
    const cases: [string, string][] = [
      ['/api/me', 'GET'],
      ['/api/sync/pull', 'POST'],
      ['/api/sync/record?id=r-1', 'GET'],
      ['/api/sync/mutate', 'POST'],
    ]
    for (const [path, method] of cases) {
      const response = await call(path, { method })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('令牌不对 → 401', async () => {
    const response = await call('/api/me', { token: 'wrong-token' })
    expect(response.status).toBe(401)
  })

  it('令牌被撤销 → 401', async () => {
    db.exec(`update access_tokens set revoked_at = '2026-09-30T00:00:00.000Z' where user_id = '${USER_A}'`)
    expect((await call('/api/me', { token: TOKEN_A })).status).toBe(401)
  })

  it('认证方案名大小写不敏感（RFC 7235）', async () => {
    const response = await worker.fetch(
      new Request(`${BASE}/api/me`, { headers: { Authorization: `bearer ${TOKEN_A}` } }),
      { DB: db },
    )
    expect(response.status).toBe(200)
  })

  it('401 也带 CORS 头 —— 否则浏览器只会报 CORS 错误，把真正原因盖住', async () => {
    const response = await call('/api/me', { origin: 'https://lhc728.github.io' })
    expect(response.status).toBe(401)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('GET /api/me', () => {
  it('返回账号信息', async () => {
    const response = await call('/api/me', { token: TOKEN_A })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: USER_A, email: 'a@example.com' })
  })

  it('email 为空时返回 null，而不是省略字段', async () => {
    const response = await call('/api/me', { token: TOKEN_B })
    expect(await response.json()).toEqual({ userId: USER_B, email: null })
  })

  it('令牌指向不存在的账号 → 404，不假装成功', async () => {
    // 外键约束下几乎不可能出现，这里强行造出来
    db.exec('pragma foreign_keys = off')
    db.exec('delete from users')
    const response = await call('/api/me', { token: TOKEN_A })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'user_not_found' })
  })
})

describe('POST /api/sync/pull', () => {
  it('空库返回空数组（不是 null）', async () => {
    const response = await call('/api/sync/pull', { method: 'POST', token: TOKEN_A })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ records: [] })
  })

  it('返回已写入的记录，字段是驼峰形状', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })

    const response = await call('/api/sync/pull', { method: 'POST', token: TOKEN_A })
    const data = (await response.json()) as { records: Record<string, unknown>[] }
    expect(data.records).toHaveLength(1)
    expect(data.records[0]).toMatchObject({
      id: 'r-1',
      userId: USER_A,
      type: 'idea',
      content: '想到的那一刻',
      createdTimezone: 'Asia/Shanghai',
      createdLocalDate: '2026-09-30',
      completedAtUtc: null,
      deletedAtUtc: null,
      version: 1,
    })
    // 下划线命名的原始列名不该漏出去
    expect(data.records[0]).not.toHaveProperty('created_at_utc')
  })

  it('★ 拉不到别人的记录', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })

    const response = await call('/api/sync/pull', { method: 'POST', token: TOKEN_B })
    expect(await response.json()).toEqual({ records: [] })
  })
})

describe('GET /api/sync/record', () => {
  it('能取到单条', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    const response = await call('/api/sync/record?id=r-1', { token: TOKEN_A })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ record: { id: 'r-1' } })
  })

  it('不存在时 record 为 null（而不是 404）—— 客户端靠它区分「没这条」和「请求失败」', async () => {
    const response = await call('/api/sync/record?id=r-none', { token: TOKEN_A })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ record: null })
  })

  it('缺少 id 参数 → 400', async () => {
    const response = await call('/api/sync/record', { token: TOKEN_A })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'missing_id' })
  })

  it('★ 拿别人的 recordId 取不到东西', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    const response = await call('/api/sync/record?id=r-1', { token: TOKEN_B })
    expect(await response.json()).toEqual({ record: null })
  })
})

describe('POST /api/sync/mutate', () => {
  it('新建成功', async () => {
    const response = await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'applied', version: 1 })
  })

  it('重放返回 already_applied', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    const response = await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    expect(await response.json()).toMatchObject({ status: 'already_applied', version: 1 })
  })

  it('版本冲突原样透出，客户端才能做三方比较', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    const response = await call('/api/sync/mutate', {
      method: 'POST',
      token: TOKEN_A,
      body: createBody({
        mutationId: 'm-2',
        operation: 'update',
        expectedVersion: 99,
        payload: { content: '不该写进去' },
      }),
    })
    expect(await response.json()).toMatchObject({ status: 'version_conflict', version: 1 })
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('想到的那一刻')
  })

  it('更新不存在的记录 → record_not_found', async () => {
    const response = await call('/api/sync/mutate', {
      method: 'POST',
      token: TOKEN_A,
      body: createBody({ recordId: 'r-none', operation: 'update', expectedVersion: 1 }),
    })
    expect(await response.json()).toMatchObject({ status: 'record_not_found' })
  })

  it('★ 不能改别人的记录', async () => {
    await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body: createBody() })
    const response = await call('/api/sync/mutate', {
      method: 'POST',
      token: TOKEN_B,
      body: createBody({ mutationId: 'm-steal', operation: 'update', expectedVersion: 1, payload: { content: '偷改' } }),
    })
    expect(await response.json()).toMatchObject({ status: 'record_not_found' })
    expect(db.row<{ content: string }>('select content from records')?.content).toBe('想到的那一刻')
  })

  describe('请求体校验 —— 宁可 400 也不把脏数据写进库', () => {
    const badBodies: [string, unknown][] = [
      ['不是对象', 'just a string'],
      ['是数组', [1, 2, 3]],
      ['缺 mutationId', { recordId: 'r-1', operation: 'create', payload: {} }],
      ['缺 recordId', { mutationId: 'm-1', operation: 'create', payload: {} }],
      ['mutationId 是空串', { mutationId: '', recordId: 'r-1', operation: 'create', payload: {} }],
      ['operation 不认识', { mutationId: 'm-1', recordId: 'r-1', operation: 'explode', payload: {} }],
      [
        'expectedVersion 不是数字',
        { mutationId: 'm-1', recordId: 'r-1', operation: 'update', expectedVersion: '1', payload: {} },
      ],
      ['payload 缺失', { mutationId: 'm-1', recordId: 'r-1', operation: 'create' }],
      ['payload 是数组', { mutationId: 'm-1', recordId: 'r-1', operation: 'create', payload: [] }],
    ]

    for (const [name, body] of badBodies) {
      it(`${name} → 400`, async () => {
        const response = await call('/api/sync/mutate', { method: 'POST', token: TOKEN_A, body })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_body' })
        expect(db.rows('select id from records')).toHaveLength(0)
      })
    }

    it('expectedVersion 是 Infinity → 400', async () => {
      // JSON 里写不出 NaN/Infinity，但 1e400 会被解析成 Infinity
      const response = await call('/api/sync/mutate', {
        method: 'POST',
        token: TOKEN_A,
        rawBody: '{"mutationId":"m-1","recordId":"r-1","operation":"update","expectedVersion":1e400,"payload":{}}',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_body' })
    })

    it('body 不是合法 JSON → 400（不是 500）', async () => {
      const response = await call('/api/sync/mutate', {
        method: 'POST',
        token: TOKEN_A,
        rawBody: '{ this is not json',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_json' })
    })
  })
})

describe('路由', () => {
  it('未知路径 → 404', async () => {
    const response = await call('/api/nope', { token: TOKEN_A })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  it('方法不对 → 404（当前只按 path + method 精确匹配）', async () => {
    expect((await call('/api/sync/pull', { method: 'GET', token: TOKEN_A })).status).toBe(404)
    expect((await call('/api/me', { method: 'POST', token: TOKEN_A })).status).toBe(404)
  })
})

describe('★ 出错时绝不返回「看起来成功」的响应', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  afterEach(() => consoleError.mockClear())

  it('数据库炸了 → 500，响应里没有任何成功迹象', async () => {
    const broken = {
      prepare() {
        throw new Error('D1_ERROR: no such table')
      },
      batch() {
        throw new Error('D1_ERROR: no such table')
      },
    }

    const response = await worker.fetch(
      new Request(`${BASE}/api/sync/mutate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer some-token' },
      }),
      { DB: broken as unknown as Env['DB'] },
    )

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' })
    // 客户端会把 status:'applied' 当成「已应用」并从 outbox 里删掉那条 mutation ——
    // 一旦这里出现 applied，就是真正的数据丢失
    expect(text).not.toContain('applied')
    // 内部错误细节只写日志，不回给调用方
    expect(text).not.toContain('no such table')
    expect(consoleError).toHaveBeenCalled()
  })

  it('鉴权阶段就炸 → 也是带 CORS 头的 500，而不是裸异常', async () => {
    const broken = {
      prepare() {
        throw new Error('boom')
      },
      batch() {
        throw new Error('boom')
      },
    }

    const response = await worker.fetch(
      new Request(`${BASE}/api/sync/pull`, {
        method: 'POST',
        headers: { Authorization: 'Bearer whatever', Origin: 'https://lhc728.github.io' },
      }),
      { DB: broken as unknown as Env['DB'] },
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
