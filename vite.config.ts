import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// 部署基路径。
// 默认 '/'（本机 dev / preview / E2E 都走这个，行为不变）；
// 部署到子路径时用环境变量覆盖，例如 GitHub Pages：
//   VITE_BASE=/yike/ npm run build
function resolveBase(raw: string): string {
  // 允许完整 URL 作为 base（CDN 场景），原样使用
  if (/^https?:\/\//.test(raw)) return raw

  // Windows 的 Git Bash（MSYS2）会把看起来像 Unix 路径的环境变量值
  // 转换成 Windows 路径：VITE_BASE=/yike/ 会变成 C:/Users/.../yike/。
  // 危险之处在于构建**照样成功**，产物却全是坏路径，部署后直接白屏。
  // 这里直接拦下来，宁可构建失败也不要静默产出坏产物。
  if (raw.includes(':') || (raw !== '/' && !raw.startsWith('/'))) {
    throw new Error(
      `VITE_BASE 不是合法的部署基路径：${raw}\n` +
        '如果你在 Windows 的 Git Bash 里构建，MSYS 会把 /yike/ 这类值转换成 Windows 路径。\n' +
        '本机构建请改用：MSYS_NO_PATHCONV=1 VITE_BASE=/yike/ npm run build\n' +
        '（Linux / macOS / CI 上没有这个问题，VITE_BASE=/yike/ 可以直接用）',
    )
  }
  return raw.endsWith('/') ? raw : `${raw}/`
}

const base = resolveBase(process.env.VITE_BASE ?? '/')

// 一刻 — 构建配置
export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/maskable-512.png',
      ],
      manifest: {
        name: '一刻',
        short_name: '一刻',
        description: '想到的那一刻，就记下来。极简、本地优先的灵感 + 待办 + 时间线工具',
        lang: 'zh-CN',
        // 全部用相对路径：manifest 自己就放在 <base>manifest.webmanifest，
        // 所以 '.' 会解析成 <base>，根路径与子路径部署都正确。
        // 写成 '/' 的话，部署到 https://xxx.github.io/yike/ 会指向域名根，直接 404。
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#FAF9F7',
        theme_color: '#FAF9F7',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 只缓存 app shell（HTML/CSS/JS/图标/字体），业务数据一律走 IndexedDB
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
})
