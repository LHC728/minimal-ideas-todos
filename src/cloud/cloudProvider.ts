/**
 * 云端适配器的分发点。
 *
 * 依赖方向：UI → Repository/Domain → IndexedDB → SyncEngine → CloudAdapter → 云
 * 上层只认 CloudAdapter 这个接口，不关心背后是 Supabase 还是自建 Worker。
 */
import type { CloudAdapter } from './CloudAdapter'
import { nullAdapter, supabaseAdapter } from './SupabaseAdapter'
import { cloudflareAdapter } from './CloudflareAdapter'
import { readCloudConfig, type CloudProviderKind } from './cloudConfig'

/** 当前生效的后端类型；未配置云端时为 null */
export function activeProviderKind(): CloudProviderKind | null {
  return readCloudConfig()?.provider ?? null
}

/**
 * 每次调用都重新读配置 —— 用户在「设置」里改完会重载页面，
 * 但同步引擎也可能在配置变化后被重新 configure，所以不要缓存实例之外的判断结果。
 */
export function createCloudAdapter(): CloudAdapter {
  const config = readCloudConfig()
  if (!config) return nullAdapter
  if (config.provider === 'cloudflare') return cloudflareAdapter
  return supabaseAdapter
}
