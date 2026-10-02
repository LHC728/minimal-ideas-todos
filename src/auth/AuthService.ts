/**
 * 账号服务（方案 §62、§63）。
 *
 * - 已配置云端：首次使用要求登录
 *     · supabase   → 邮箱验证码 / Magic Link
 *     · cloudflare → 粘贴访问令牌
 * - 未配置云端：进入本机模式，用固定的 LOCAL_USER_ID，一切照常可用
 * - 从本机模式首次登录时，把本机记录归入该账号，绝不丢数据（§81）
 *
 * 关键取舍：**离线必须能用**。
 * Cloudflare 那条路把 userId 缓存在本机，启动时立刻可用，
 * 再在后台向服务器确认令牌是否还有效 —— 否则断网就永远拿不到 userId，
 * 「离线正常」这条承诺会直接失效。
 */
import type { Session } from '@supabase/supabase-js'
import { getSupabaseClient } from '../cloud/supabaseClient'
import {
  readCloudConfig,
  saveCloudConfig,
  type CloudProviderKind,
} from '../cloud/cloudConfig'
import { readCloudflareSession, saveCloudflareSession } from '../cloud/cloudflareSession'
import { cfRequest, CloudRequestError } from '../cloud/cloudflareClient'
import { LOCAL_USER_ID, migrateLocalRecordsToUser } from '../db/recordRepository'

export type AuthMode = 'local' | 'cloud'

export interface AuthUser {
  id: string
  email: string | null
}

export interface AuthState {
  ready: boolean
  mode: AuthMode
  user: AuthUser | null
  cloudConfigured: boolean
  /** 当前配置的后端类型；本机模式为 null */
  provider: CloudProviderKind | null
  /** 登录时自动并入账号的本机记录数 */
  migratedCount: number
}

interface MeResponse {
  userId?: string
  email?: string | null
  error?: string
}

function userFromSession(session: Session | null): AuthUser | null {
  const user = session?.user
  if (!user) return null
  return { id: user.id, email: user.email ?? null }
}

/**
 * 应用所在的完整地址（**含子路径**）。
 *
 * ⚠️ 不能用 `location.origin` —— 线上部署在 GitHub Pages 的子路径 `/yike/` 下，
 * origin 只有 `https://lhc728.github.io`，而应用实际在 `/yike/`。
 * 邮件里的登录链接会落到站点根目录，直接 404。
 * 必须把 Vite 的 `BASE_URL` 拼进去（本地为 `/`，线上为 `/yike/`）。
 */
function appBaseUrl(): string | undefined {
  const origin = globalThis.location?.origin
  if (!origin) return undefined
  try {
    return new URL(import.meta.env?.BASE_URL ?? '/', origin).toString()
  } catch {
    return origin
  }
}

class AuthService {
  private listeners = new Set<() => void>()
  private snapshot: AuthState = {
    ready: false,
    mode: readCloudConfig() ? 'cloud' : 'local',
    user: null,
    cloudConfigured: readCloudConfig() !== null,
    provider: readCloudConfig()?.provider ?? null,
    migratedCount: 0,
  }
  private unsubscribeAuth: (() => void) | null = null
  private initialized = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): AuthState => this.snapshot

  private emit(next: Partial<AuthState>): void {
    const merged = { ...this.snapshot, ...next }
    if (
      merged.ready === this.snapshot.ready &&
      merged.mode === this.snapshot.mode &&
      merged.cloudConfigured === this.snapshot.cloudConfigured &&
      merged.provider === this.snapshot.provider &&
      merged.migratedCount === this.snapshot.migratedCount &&
      merged.user?.id === this.snapshot.user?.id &&
      merged.user?.email === this.snapshot.user?.email
    ) {
      return
    }
    this.snapshot = merged
    for (const listener of this.listeners) listener()
  }

  /** 应用启动时调用一次 */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const config = readCloudConfig()

    if (!config) {
      this.emit({
        ready: true,
        mode: 'local',
        cloudConfigured: false,
        provider: null,
        user: { id: LOCAL_USER_ID, email: null },
      })
      return
    }

    if (config.provider === 'cloudflare') {
      await this.initCloudflare()
      return
    }

    await this.initSupabase()
  }

  // ---------------------------------------------------------------
  // Cloudflare：访问令牌
  // ---------------------------------------------------------------

  private async initCloudflare(): Promise<void> {
    const session = readCloudflareSession()

    if (session === null) {
      this.emit({
        ready: true,
        mode: 'cloud',
        cloudConfigured: true,
        provider: 'cloudflare',
        user: null,
      })
      return
    }

    // 先用本机缓存的账号信息立刻可用 —— 断网也照常工作
    await this.adoptLocalRecords(session.userId)
    this.emit({
      ready: true,
      mode: 'cloud',
      cloudConfigured: true,
      provider: 'cloudflare',
      user: { id: session.userId, email: session.email },
    })

    // 再在后台确认令牌是否还有效。只有明确的 401 才判定为失效，
    // 网络错误不算 —— 否则出门断网一次就被踢下线，那是很糟的体验。
    try {
      const me = await cfRequest<MeResponse>('/api/me')
      if (me.userId) {
        saveCloudflareSession({
          token: session.token,
          userId: me.userId,
          email: me.email ?? null,
        })
        await this.adoptLocalRecords(me.userId)
        this.emit({ user: { id: me.userId, email: me.email ?? null } })
      }
    } catch (error) {
      if (error instanceof CloudRequestError && error.status === 401) {
        saveCloudflareSession(null)
        this.emit({ user: null })
      }
    }
  }

  /**
   * 用「Worker 地址 + 访问令牌」登录。
   *
   * 顺序很重要：**先验证、再落盘**。
   * 反过来的话，输错一次令牌就会在本地留下一份坏配置，
   * 之后每次启动都拿它去请求、每次失败 —— 排查起来很痛苦。
   */
  async signInWithCloudflare(url: string, token: string): Promise<void> {
    const trimmedUrl = url.trim().replace(/\/+$/, '')
    const trimmedToken = token.trim()
    if (trimmedUrl === '' || trimmedToken === '') throw new Error('missing_credentials')

    const me = await cfRequest<MeResponse>('/api/me', {
      client: { url: trimmedUrl, token: trimmedToken },
    })
    if (!me.userId) throw new Error(me.error ?? 'invalid_token')

    saveCloudConfig({ provider: 'cloudflare', url: trimmedUrl })
    saveCloudflareSession({
      token: trimmedToken,
      userId: me.userId,
      email: me.email ?? null,
    })

    await this.adoptLocalRecords(me.userId)
    this.emit({
      ready: true,
      mode: 'cloud',
      cloudConfigured: true,
      provider: 'cloudflare',
      user: { id: me.userId, email: me.email ?? null },
    })
  }

  // ---------------------------------------------------------------
  // Supabase：邮箱验证码
  // ---------------------------------------------------------------

  private async initSupabase(): Promise<void> {
    const client = getSupabaseClient()

    if (!client) {
      this.emit({
        ready: true,
        mode: 'local',
        cloudConfigured: false,
        provider: null,
        user: { id: LOCAL_USER_ID, email: null },
      })
      return
    }

    const { data } = await client.auth.getSession()
    const session = data.session ?? null

    if (session) {
      await this.adoptLocalRecords(session.user.id)
    }

    this.emit({
      ready: true,
      mode: 'cloud',
      cloudConfigured: true,
      provider: 'supabase',
      user: userFromSession(session),
    })

    const { data: sub } = client.auth.onAuthStateChange((_event, nextSession) => {
      const nextUser = userFromSession(nextSession)
      void this.adoptLocalRecords(nextUser?.id ?? null).then(() => {
        this.emit({ user: nextUser })
      })
    })
    this.unsubscribeAuth = () => sub.subscription.unsubscribe()
  }

  // ---------------------------------------------------------------
  // 公共
  // ---------------------------------------------------------------

  private async adoptLocalRecords(userId: string | null): Promise<void> {
    if (!userId) return
    try {
      const count = await migrateLocalRecordsToUser(userId)
      if (count > 0) this.emit({ migratedCount: count })
    } catch {
      // 迁移失败不阻塞登录
    }
  }

  clearMigratedCount(): void {
    this.emit({ migratedCount: 0 })
  }

  /** 发送邮箱验证码（仅 Supabase） */
  async sendEmailCode(email: string): Promise<void> {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    // 拿不到地址时干脆不传这个参数 —— 传一个假的相对地址反而会让服务端拒绝
    const redirectTo = appBaseUrl()
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        ...(redirectTo === undefined ? {} : { emailRedirectTo: redirectTo }),
      },
    })
    if (error) throw new Error(error.message)
  }

  /** 校验邮箱验证码（仅 Supabase） */
  async verifyEmailCode(email: string, token: string): Promise<void> {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    const { data, error } = await client.auth.verifyOtp({
      email: email.trim(),
      token: token.trim(),
      type: 'email',
    })
    if (error) throw new Error(error.message)
    if (data.user) await this.adoptLocalRecords(data.user.id)
    this.emit({ user: userFromSession(data.session) })
  }

  async signOut(): Promise<void> {
    if (this.snapshot.provider === 'cloudflare') {
      // 只清会话，保留连接配置 —— 否则会被判为「未配置」而掉回本机模式
      saveCloudflareSession(null)
      this.emit({ user: null })
      return
    }

    const client = getSupabaseClient()
    if (client) await client.auth.signOut()
    this.emit({ user: null })
  }

  dispose(): void {
    this.unsubscribeAuth?.()
    this.unsubscribeAuth = null
  }
}

export const authService = new AuthService()

/** 当前生效的 userId（登录用户或本机账号） */
export function currentUserId(state: AuthState): string | null {
  if (state.mode === 'local') return LOCAL_USER_ID
  return state.user?.id ?? null
}
