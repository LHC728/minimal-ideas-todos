import { Navigate, Route, Routes } from 'react-router-dom'
import { Search, Settings } from 'lucide-react'
import { BottomNav } from '../components/BottomNav'
import { DesktopSidebar } from '../components/DesktopSidebar'
import { SyncIndicator } from '../components/SyncIndicator'
import { RecordDetail, RecordDetailPanel } from '../components/RecordDetail'
import { SearchPanel } from '../components/SearchPanel'
import { SettingsSheet } from '../components/SettingsSheet'
import { ConflictDialog } from '../components/ConflictDialog'
import { Toaster } from '../components/Toaster'
import { uiActions, useUi } from './uiStore'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { HomePage } from '../pages/HomePage'
import { IdeasPage } from '../pages/IdeasPage'
import { CalendarPage } from '../pages/CalendarPage'
import { TodosPage } from '../pages/TodosPage'
import { deviceTimeZone } from '../utils/time'

interface AppShellProps {
  userId: string
}

/**
 * 应用外壳：四个一级入口 + 辅助功能（搜索 / 设置 / 详情 / 冲突）。
 *
 * 手机：底部导航 + 详情用底部抽屉。
 * 桌面：左侧导航 + 中间内容 + 右侧详情面板 —— 点开一条记录不会丢掉列表上下文。
 */
export function AppShell({ userId }: AppShellProps) {
  const ui = useUi()
  const timezone = deviceTimeZone()
  // 手机与桌面只渲染各自生效的导航，DOM 里始终只有一个「主导航」
  const isDesktop = useIsDesktop()

  return (
    <div className="flex min-h-screen w-full bg-canvas">
      {isDesktop ? <DesktopSidebar userId={userId} /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top sticky top-0 z-20 border-b border-line bg-canvas/92 backdrop-blur">
          <div className="flex h-12 items-center justify-between gap-3 px-4">
            <SyncIndicator userId={userId} />

            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="搜索"
                onClick={uiActions.openSearch}
                data-testid="open-search"
                className="tap tap-active flex h-9 w-9 items-center justify-center rounded-[8px] text-ink-soft"
              >
                <Search size={17} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                aria-label="设置"
                onClick={uiActions.openSettings}
                data-testid="open-settings"
                className="tap tap-active flex h-9 w-9 items-center justify-center rounded-[8px] text-ink-soft"
              >
                <Settings size={17} strokeWidth={1.7} />
              </button>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 pb-[calc(60px+env(safe-area-inset-bottom))] md:pb-0">
          <Routes>
            <Route path="/" element={<HomePage userId={userId} />} />
            <Route path="/ideas" element={<IdeasPage userId={userId} />} />
            <Route path="/calendar" element={<CalendarPage userId={userId} />} />
            <Route path="/todos" element={<TodosPage userId={userId} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {isDesktop ? (
        <RecordDetailPanel
          key={ui.selectedRecordId ?? 'no-record'}
          recordId={ui.selectedRecordId}
          onClose={uiActions.closeRecord}
        />
      ) : null}

      {isDesktop ? null : <BottomNav />}

      {isDesktop ? null : (
        <RecordDetail
          key={ui.selectedRecordId ?? 'no-record'}
          recordId={ui.selectedRecordId}
          onClose={uiActions.closeRecord}
        />
      )}

      <SearchPanel userId={userId} open={ui.searchOpen} timezone={timezone} />
      <SettingsSheet
        key={ui.settingsOpen ? 'settings-open' : 'settings-closed'}
        open={ui.settingsOpen}
        userId={userId}
      />
      <ConflictDialog userId={userId} />
      <Toaster />
    </div>
  )
}
