import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { themeStore } from './app/themeStore'
import { ErrorBoundary } from './components/ErrorBoundary'

const container = document.getElementById('root')
if (!container) throw new Error('root container not found')

// 主题要在渲染之前启动：首屏那一次套用已经由 index.html 的内联脚本做了，
// 这里补上后续的（同步 store、修正 theme-color、跟随系统变化）。
themeStore.start()

createRoot(container).render(
  <StrictMode>
    {/* 边界必须在 App 之外 —— 挂在里面的话，App 自身抛错就没人接了 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// PWA：只在生产构建中注册 Service Worker，缓存 app shell（不缓存业务数据）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true })
    })
    .catch(() => {
      // 注册失败不影响本地使用
    })
}
