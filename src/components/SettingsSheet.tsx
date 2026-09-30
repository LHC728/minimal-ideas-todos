import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { useAuth } from '../hooks/useSyncStatus'
import { authService } from '../auth/AuthService'
import { usePendingCount, useAllRecords } from '../hooks/useRecords'
import { syncEngine } from '../sync/SyncEngine'
import { useSyncStatus } from '../sync/syncStatus'
import {
  readCloudConfig,
  readEnvCloudConfig,
  readStoredCloudConfig,
  saveCloudConfig,
} from '../cloud/cloudConfig'
import { resetSupabaseClient } from '../cloud/supabaseClient'
import { formatChineseDateTime } from '../utils/time'
import { uiActions } from '../app/uiStore'
import { Modal } from './Modal'

interface SettingsSheetProps {
  open: boolean
  userId: string | null
}

const PHASE_TEXT: Record<string, string> = {
  idle: '已就绪',
  syncing: '正在同步…',
  synced: '已同步',
  offline: '离线',
  error: '暂时无法同步',
  local: '仅本机（未连接云端）',
  'signed-out': '未登录',
}

/**
 * 设置（方案 §4）：只放账号和同步状态，不作为主模块。
 */
export function SettingsSheet({ open, userId }: SettingsSheetProps) {
  const auth = useAuth()
  const status = useSyncStatus()
  const pending = usePendingCount(userId)
  const records = useAllRecords(userId)

  // 每次打开由调用方通过 key 重新挂载，表单初值直接来自本机配置
  const [url, setUrl] = useState(() => readCloudConfig()?.url ?? '')
  const [key, setKey] = useState(() => readCloudConfig()?.anonKey ?? '')
  const [saved, setSaved] = useState(false)

  if (!open) return null

  const envConfig = readEnvCloudConfig()
  const storedConfig = readStoredCloudConfig()

  function handleSaveCloud() {
    saveCloudConfig(url.trim() && key.trim() ? { url, anonKey: key } : null)
    resetSupabaseClient()
    setSaved(true)
    // 连接配置变化需要重新初始化账号与同步
    setTimeout(() => window.location.reload(), 600)
  }

  async function handleSignOut() {
    await authService.signOut()
    uiActions.closeSettings()
  }

  return (
    <Modal open onClose={uiActions.closeSettings} title="设置" widthClass="md:max-w-md">
      <section className="mb-6">
        <h3 className="text-[12.5px] font-medium text-ink-soft">账号</h3>
        <div className="mt-2 space-y-1.5 text-[14px] text-ink-soft">
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">模式</span>
            <span>{auth.mode === 'local' ? '本机模式' : '云端账号'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">邮箱</span>
            <span className="truncate">{auth.user?.email ?? '—'}</span>
          </div>
        </div>

        {auth.mode === 'cloud' && auth.user ? (
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="tap tap-active mt-3 flex h-10 items-center gap-2 rounded-xl border border-line px-3.5 text-[14px] text-ink-soft"
          >
            <LogOut size={15} strokeWidth={1.7} />
            退出登录
          </button>
        ) : null}
      </section>

      <section className="mb-6">
        <h3 className="text-[12.5px] font-medium text-ink-soft">同步状态</h3>
        <div className="mt-2 space-y-1.5 text-[14px] text-ink-soft">
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">状态</span>
            <span data-testid="settings-sync-phase">{PHASE_TEXT[status.phase] ?? status.phase}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">待同步</span>
            <span data-testid="settings-pending">{pending} 条</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">本机记录</span>
            <span>{records.length} 条</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-ink-soft">上次同步</span>
            <span>
              {status.lastSyncedAt ? formatChineseDateTime(status.lastSyncedAt) : '—'}
            </span>
          </div>
        </div>

        {status.message ? (
          <p className="mt-2.5 rounded-xl bg-idea-soft px-3 py-2 text-[13px] leading-5 text-idea">
            {status.message}
          </p>
        ) : null}

        {auth.mode === 'cloud' && auth.user ? (
          <button
            type="button"
            onClick={() => void syncEngine.sync('manual')}
            className="tap tap-active mt-3 h-10 rounded-xl border border-line px-3.5 text-[14px] text-ink-soft"
          >
            立即同步
          </button>
        ) : null}
      </section>

      <section>
        <h3 className="text-[12.5px] font-medium text-ink-soft">云端连接</h3>
        {envConfig ? (
          <p className="mt-2 text-[13px] leading-5 text-ink-soft">
            已由构建期环境变量提供连接信息。
          </p>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-5 text-ink-soft">
              填入 Supabase 项目地址与 anon key 即可开启多设备同步。留空则保持仅本机使用，
              所有功能仍然完整可用。
            </p>
            <div className="mt-2.5 space-y-2">
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://xxxx.supabase.co"
                aria-label="Supabase URL"
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-idea/40"
              />
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="anon key"
                aria-label="Supabase anon key"
                className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-idea/40"
              />
            </div>
            <button
              type="button"
              onClick={handleSaveCloud}
              className="tap tap-active mt-2.5 h-10 rounded-xl bg-idea px-4 text-[14px] font-medium text-white"
            >
              {saved ? '已保存，正在重载…' : '保存连接'}
            </button>
            {storedConfig ? (
              <p className="mt-2 text-[12px] text-ink-soft">当前已保存本机连接配置。</p>
            ) : null}
          </>
        )}
      </section>
    </Modal>
  )
}
