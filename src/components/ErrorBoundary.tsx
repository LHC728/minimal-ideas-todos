import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 顶层错误边界。
 *
 * 为什么必须有（见 docs/代码审查-基线审计报告.md §2.4）：
 *   React 18/19 里，渲染期抛出的异常会**卸载整棵树**，页面直接变白。
 *   用户看到白屏的第一反应是「我的记录全没了」—— 而实际上记录全都在
 *   IndexedDB 里，一条都没丢，只是这一屏没画出来。
 *   这个组件唯一的职责就是：把「数据还在」这句话说出来，并给一个恢复入口。
 *
 * ⚠️ 边界的能力范围：
 *   只能捕获**渲染期**（含生命周期、子组件构造）的异常。
 *   事件回调、setTimeout、Promise 里的异常不会被它接住 ——
 *   那些位置仍需各自的 try/catch（例如 authService / syncEngine 的错误处理）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留现场：控制台里能看到组件栈，便于定位是哪一棵子树炸的
    console.error('[一刻] 界面渲染出错', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <div className="card-raised w-full max-w-[380px] rounded-[16px] px-5 py-6 text-center">
          <h1 className="text-[16px] font-medium text-ink">界面出了点问题</h1>

          <p className="mt-2 text-[13px] leading-[1.6] text-ink-soft">
            你的记录都还在本机，一条都没有丢 —— 只是这一屏没能画出来。
          </p>
          <p className="mt-1 text-[13px] leading-[1.6] text-ink-soft">
            重新加载通常就能恢复。若反复出现，请把下面这行发给开发者。
          </p>

          <p
            data-testid="error-boundary-message"
            className="mt-3 break-words rounded-[8px] bg-sunken px-3 py-2 text-left font-mono text-[11px] leading-[1.5] text-ink-soft"
          >
            {error.message || String(error)}
          </p>

          <button
            type="button"
            onClick={this.handleReload}
            className="tap tap-active mt-4 flex h-11 w-full items-center justify-center rounded-[10px] border border-line text-[15px] font-medium text-ink"
          >
            重新加载
          </button>
        </div>
      </div>
    )
  }
}
