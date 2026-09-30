/**
 * Supabase 客户端单例。
 * AuthService 与 SupabaseAdapter 共用同一个 client。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readCloudConfig } from './cloudConfig'

let cached: { url: string; key: string; client: SupabaseClient } | null = null

export function getSupabaseClient(): SupabaseClient | null {
  const config = readCloudConfig()
  if (!config) return null
  if (cached && cached.url === config.url && cached.key === config.anonKey) {
    return cached.client
  }
  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'inspiration-todo/auth',
    },
  })
  cached = { url: config.url, key: config.anonKey, client }
  return client
}

export function resetSupabaseClient(): void {
  cached = null
}
