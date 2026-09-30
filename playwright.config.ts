import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    // 固定时区，让「今天」在测试里可预期
    timezoneId: 'Asia/Shanghai',
    trace: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // 跑 E2E 前请先 `npm run build`（preview 读的是 dist/）。
    // 提示：部分 Windows 环境下 Playwright 自行关闭 webServer 会卡住，
    // 此时先在另一个终端常驻 `npm run preview`，本配置会复用它（reuseExistingServer）。
    command: `npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
