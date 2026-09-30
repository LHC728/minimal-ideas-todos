import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const container = document.getElementById('root')
if (!container) throw new Error('root container not found')

createRoot(container).render(
  <StrictMode>
    <App />
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
