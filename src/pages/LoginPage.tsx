import { useState } from 'react'
import { authService } from '../auth/AuthService'
import { useAuth } from '../hooks/useSyncStatus'
import { readCloudConfig, saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { resetSupabaseClient } from '../cloud/supabaseClient'
import { CloudRequestError } from '../cloud/cloudflareClient'

/**
 * 登录（方案 §62、§63）。
 *
 * 两种后端对应两种登录方式：
 *   - supabase   → 邮箱验证码 / Magic Link
 *   - cloudflare → 粘贴访问令牌（没有邮箱服务，也不需要密码）
 *
 * 刻意不引入用户名、头像、昵称、社交登录矩阵。
 */
export function LoginPage() {
  const auth = useAuth()
  if (auth.provider === 'cloudflare') return <TokenLogin />
  return <EmailCodeLogin />
}

/**
 * 配置填错时的**唯一退路**。
 *
 * 没有它就会死锁：`App` 在「已配置云端但未登录」时只渲染登录页，
 * 而登录页原本没有任何入口能回到本机模式 —— 地址或 key 填错一次，
 * 用户就再也进不去设置页，也退不回本机模式，只能卸载重装（会丢本机记录）。
 *
 * 注意：这里**只清连接配置**，不动 IndexedDB —— 本机记录一条都不会少。
 */
function DisconnectLink() {
  function disconnect(): void {
    saveCloudConfig(null)
    saveCloudflareSession(null)
    resetSupabaseClient()
    window.location.reload()
  }

  return (
    <button
      type="button"
      onClick={disconnect}
      className="tap tap-active mt-5 text-[12.5px] text-ink-soft underline underline-offset-4"
    >
      连不上？断开云端连接，先只用本机
    </button>
  )
}

// ---------------------------------------------------------------
// Cloudflare：访问令牌
// ---------------------------------------------------------------

function TokenLogin() {
  const [url, setUrl] = useState(() => readCloudConfig()?.url ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    if (busy) return
    if (!url.trim() || !token.trim()) {
      setError('请把 Worker 地址和访问令牌都填上。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await authService.signInWithCloudflare(url, token)
    } catch (err) {
      if (err instanceof CloudRequestError && err.status === 401) {
        setError('这个令牌不被接受。可能是打错了，或者它已经被吊销。')
      } else if (err instanceof TypeError) {
        setError('连不上这个地址。检查一下 Worker 地址是否写对了、网络是否正常。')
      } else {
        setError(err instanceof Error ? err.message : '连接失败，请稍后再试。')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-[360px]">
        <h1 className="text-[20px] font-medium tracking-[0.06em] text-ink">一刻</h1>
        <p className="mt-1.5 text-[13px] leading-6 text-ink-soft">
          填入你的同步服务地址和访问令牌，手机和电脑就会自动同步。
          <br />
          记录永远先保存在本机，断网也能用。
        </p>

        <div className="mt-6 space-y-2.5">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://yike-sync.xxxx.workers.dev"
            aria-label="同步服务地址"
            autoComplete="off"
            className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-idea/40"
          />
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="访问令牌"
            aria-label="访问令牌"
            autoComplete="off"
            className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-[14px] text-ink outline-none focus:border-idea/40"
          />
        </div>

        {error ? (
          <p data-testid="login-error" className="mt-3 text-[13px] leading-5 text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => void connect()}
          className="tap tap-active mt-4 h-11 w-full rounded-xl bg-idea text-[15px] font-medium text-on-idea disabled:opacity-50"
        >
          {busy ? '正在连接…' : '连接'}
        </button>

        <p className="mt-3 text-[12px] leading-5 text-ink-soft">
          访问令牌相当于这个账号的钥匙，别发给别人。
          丢失或泄露时，在服务端删掉它即可立刻作废。
        </p>

        <DisconnectLink />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// Supabase：邮箱验证码
// ---------------------------------------------------------------

function EmailCodeLogin() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function sendCode() {
    if (!email.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await authService.sendEmailCode(email)
      setStage('code')
      setNotice('验证码已发送，请查收邮箱。邮件里的链接也可以直接登录。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await authService.verifyEmailCode(email, code)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败，请检查验证码。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-[360px]">
        <h1 className="text-[20px] font-medium tracking-[0.06em] text-ink">一刻</h1>
        <p className="mt-1.5 text-[13px] leading-6 text-ink-soft">
          登录后手机和电脑会自动同步。
          <br />
          记录永远先保存在本机，断网也能用。
        </p>

        <div className="mt-6 space-y-2.5">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="邮箱地址"
            autoComplete="email"
            className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-idea/40"
          />

          {stage === 'code' ? (
            <input
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="6 位验证码"
              className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[15px] tracking-[0.2em] text-ink outline-none focus:border-idea/40"
            />
          ) : null}
        </div>

        {notice ? <p className="mt-3 text-[13px] text-ink-soft">{notice}</p> : null}
        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => (stage === 'email' ? void sendCode() : void verify())}
          className="tap tap-active mt-4 h-11 w-full rounded-xl bg-idea text-[15px] font-medium text-on-idea disabled:opacity-50"
        >
          {stage === 'email' ? '发送验证码' : '登录'}
        </button>

        {stage === 'code' ? (
          <button
            type="button"
            onClick={() => void sendCode()}
            className="tap tap-active mt-3 h-10 w-full rounded-xl text-[13.5px] text-ink-soft"
          >
            重新发送
          </button>
        ) : null}

        <DisconnectLink />
      </div>
    </div>
  )
}
