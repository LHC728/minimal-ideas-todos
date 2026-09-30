/**
 * 顶层错误边界（基线审计 §2.4）。
 *
 * 这是本仓库**唯一的组件层单元测试**，理由是它在 E2E 里触达不到：
 * 要让边界生效，必须先让渲染期抛错，而这在生产构建里没有入口
 * （也不该为了测试往生产代码里塞开关）。
 *
 * 其余组件的覆盖仍由 e2e/app.spec.ts 负责。
 * 判定依据见 docs/代码审查标准与流程.md §4「测试放在哪一层」。
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../components/ErrorBoundary'

/** 一个必定在渲染期抛错的子组件 */
function Boom(): never {
  throw new Error('渲染期炸了')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React 捕获到错误后还会往控制台再打一份，测试里静音，避免刷屏
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('一切正常时原样渲染子节点，不显示兜底界面', () => {
    render(
      <ErrorBoundary>
        <span>一切正常</span>
      </ErrorBoundary>,
    )

    expect(screen.getByText('一切正常')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-message')).toBeNull()
  })

  it('子节点抛错时兜底，并明确告诉用户「数据没丢」', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    // 关键：白屏是本 APP 最坏的失败形态，因为它会被误读成「记录没了」。
    // 兜底界面必须主动否定这个误解。
    expect(screen.getByText(/你的记录都还在本机/)).toBeTruthy()
    expect(screen.getByTestId('error-boundary-message').textContent).toBe('渲染期炸了')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
  })

  it('错误信息为空串时退化为 Error 本身，不会渲染出一块空白', () => {
    function Blank(): never {
      throw new Error('')
    }

    render(
      <ErrorBoundary>
        <Blank />
      </ErrorBoundary>,
    )

    expect(screen.getByTestId('error-boundary-message').textContent).toBe('Error')
  })
})
