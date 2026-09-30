/**
 * 账号服务（方案 §62、§63）。
 *
 * - 已配置云端：首次使用要求登录（邮箱验证码 / Magic Link 同一次调用即可）
 * - 未配置云端：进入本机模式，用固定的 LOCAL_USER_ID，一切照常可用
 * - 从本机模式首次登录时，把本机记录归入该账号，绝不丢数据（§81）
 */
import type { Session } from '@supabase/supabase-js'
import { getSupabaseClient } from '../cloud/supabaseClient'
import { isCloudConfigured } from '../cloud/cloudConfig'
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
  /** 登录时自动并入账号的本机记录数 */
  migratedCount: number
}

function userFromSession(session: Session | null): AuthUser | null {
  const user = session?.user
  if (!user) return null
  return { id: user.id, email: user.email ?? null }
}

class AuthService {
  private listeners = new Set<() => void>()
  private snapshot: AuthState = {
    ready: false,
    mode: isCloudConfigured() ? 'cloud' : 'local',
    user: null,
    cloudConfigured: isCloudConfigured(),
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

    const configured = isCloudConfigured()
    const client = getSupabaseClient()

    if (!configured || !client) {
      this.emit({
        ready: true,
        mode: 'local',
        cloudConfigured: false,
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

  /** 发送邮箱验证码（邮件里同时带 Magic Link） */
  async sendEmailCode(email: string): Promise<void> {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: globalThis.location?.origin ?? undefined,
      },
    })
    if (error) throw new Error(error.message)
  }

  /** 校验邮箱验证码 */
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
