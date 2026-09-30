import { useState } from 'react'
import { authService } from '../auth/AuthService'

/**
 * 登录（方案 §62、§63）。
 * V1 只做邮箱验证码 / Magic Link，不做用户名、头像、昵称、社交登录矩阵。
 */
export function LoginPage() {
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
        <h1 className="text-[19px] font-medium text-ink">灵感与待办</h1>
        <p className="mt-1.5 text-[13.5px] leading-6 text-ink-soft">
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
          className="tap tap-active mt-4 h-11 w-full rounded-xl bg-idea text-[15px] font-medium text-white disabled:opacity-50"
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
      </div>
    </div>
  )
}
