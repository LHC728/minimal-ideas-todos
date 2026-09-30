/**
 * 云端连接配置。
 *
 * 优先读构建期环境变量（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY），
 * 也可以在「设置」里粘贴，保存在本机 localStorage，避免必须重新构建。
 */

/**
 * ⚠️ 存储键，不是显示名 —— 改了会丢掉用户已填好的云端配置。
 * 产品名请改 index.html / manifest。
 */
const STORAGE_KEY = 'inspiration-todo/cloud-config'

export interface CloudConfig {
  url: string
  anonKey: string
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').trim()
}

function fromEnv(): CloudConfig | null {
  const url = normalize(import.meta.env?.VITE_SUPABASE_URL)
  const anonKey = normalize(import.meta.env?.VITE_SUPABASE_ANON_KEY)
  if (url && anonKey) return { url, anonKey }
  return null
}

function fromStorage(): CloudConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CloudConfig>
    const url = normalize(parsed.url)
    const anonKey = normalize(parsed.anonKey)
    if (url && anonKey) return { url, anonKey }
    return null
  } catch {
    return null
  }
}

export function readCloudConfig(): CloudConfig | null {
  return fromStorage() ?? fromEnv()
}

export function readStoredCloudConfig(): CloudConfig | null {
  return fromStorage()
}

export function readEnvCloudConfig(): CloudConfig | null {
  return fromEnv()
}

export function saveCloudConfig(config: CloudConfig | null): void {
  try {
    if (!config || !config.url || !config.anonKey) {
      globalThis.localStorage?.removeItem(STORAGE_KEY)
      return
    }
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ url: config.url.trim(), anonKey: config.anonKey.trim() }),
    )
  } catch {
    // 忽略存储异常，不影响本地使用
  }
}

export function isCloudConfigured(): boolean {
  return readCloudConfig() !== null
}
