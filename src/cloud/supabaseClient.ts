/**
 * Supabase 客户端单例。
 * AuthService 与 SupabaseAdapter 共用同一个 client。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readCloudConfig } from './cloudConfig'

let cached: { url: string; key: string; client: SupabaseClient } | null = null

export function getSupabaseClient(): SupabaseClient | null {
  const config = readCloudConfig()
  // 配的是 Cloudflare 时不能返回 Supabase 客户端 ——
  // 否则同步引擎会拿着自建后端的配置去连 Supabase，报一堆莫名其妙的错。
  if (!config || config.provider !== 'supabase') return null
  if (cached && cached.url === config.url && cached.key === config.anonKey) {
    return cached.client
  }
  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // ⚠️ 存储键，不是显示名 —— 改了会把已登录用户踢下线。
      // 产品名请改 index.html / manifest。
      storageKey: 'inspiration-todo/auth',
    },
  })
  cached = { url: config.url, key: config.anonKey, client }
  return client
}

export function resetSupabaseClient(): void {
  cached = null
}
