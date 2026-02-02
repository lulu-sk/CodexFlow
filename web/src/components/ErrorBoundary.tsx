// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message?: string; countdown?: number };

/**
 * 中文说明：React 渲染错误边界。
 * - 捕获渲染阶段异常并记录日志（主进程）。
 * - 出错后展示倒计时并在 10 秒后自动刷新，避免界面卡死无法恢复。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  private autoReloadTimerId: number | null = null;
  private autoReloadRemainingSeconds: number | null = null;
  private hasTriggeredReload = false;

  /**
   * 中文说明：初始化错误边界状态。
   * @param props 组件属性。
   */
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  /**
   * 中文说明：将异常转换为错误态，触发 fallback UI。
   * @param error 捕获到的异常。
   * @returns 错误边界状态。
   */
  static getDerivedStateFromError(error: any): State {
    return { hasError: true, message: String(error?.message || error) };
  }

  /**
   * 中文说明：捕获渲染异常并记录日志，同时启动自动刷新倒计时。
   * @param error 捕获到的异常。
   * @param info React 组件堆栈等信息。
   */
  componentDidCatch(error: any, info: any) {
    try {
      void (window as any)?.host?.utils?.perfLog?.(
        `[ErrorBoundary] ${String(error?.stack || error)} | info=${JSON.stringify(info)}`
      );
    } catch {}

    this.startAutoReloadCountdown(10);
  }

  /**
   * 中文说明：组件卸载时清理定时器，避免内存泄漏。
   */
  componentWillUnmount() {
    this.clearAutoReloadCountdown();
  }

  /**
   * 中文说明：立即刷新页面（渲染进程 reload）。
   */
  private reloadNow = () => {
    if (this.hasTriggeredReload) return;
    this.hasTriggeredReload = true;
    this.clearAutoReloadCountdown();

    try {
      void (window as any)?.host?.utils?.perfLog?.('[ErrorBoundary] auto reload now');
    } catch {}

    try {
      window.location.reload();
    } catch {
      // 兜底：极端情况下 reload 失败则尝试重置 href
      try {
        window.location.href = window.location.href;
      } catch {}
    }
  };

  /**
   * 中文说明：启动自动刷新倒计时（每秒递减一次）。
   * @param seconds 倒计时秒数。
   */
  private startAutoReloadCountdown(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    this.hasTriggeredReload = false;
    this.clearAutoReloadCountdown();
    this.autoReloadRemainingSeconds = safeSeconds;
    this.setState({ countdown: safeSeconds });

    if (safeSeconds <= 0) {
      this.reloadNow();
      return;
    }

    this.autoReloadTimerId = window.setInterval(() => {
      const current = this.autoReloadRemainingSeconds ?? safeSeconds;
      const next = current - 1;
      this.autoReloadRemainingSeconds = Math.max(0, next);
      this.setState({ countdown: this.autoReloadRemainingSeconds });
      if (next <= 0) this.reloadNow();
    }, 1000);
  }

  /**
   * 中文说明：清理自动刷新倒计时定时器。
   */
  private clearAutoReloadCountdown() {
    this.autoReloadRemainingSeconds = null;
    if (this.autoReloadTimerId == null) return;
    try {
      window.clearInterval(this.autoReloadTimerId);
    } catch {}
    this.autoReloadTimerId = null;
  }

  /**
   * 中文说明：停止自动刷新倒计时（允许用户保留在错误页查看信息）。
   */
  private stopAutoReloadCountdown = () => {
    this.clearAutoReloadCountdown();
    this.setState({ countdown: undefined });
  }

  /**
   * 中文说明：渲染正常内容或错误态 UI。
   * @returns React 节点。
   */
  render() {
    if (this.state.hasError) {
      const hasCountdown = typeof this.state.countdown === 'number';
      return (
        <div
          style={{
            padding: 16,
            fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI',
            backgroundColor: 'var(--cf-app-bg)',
            color: 'var(--cf-text-primary)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>渲染出错（已记录日志）</div>
          <div style={{ fontSize: 12, color: 'var(--cf-text-secondary)' }}>{this.state.message}</div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {hasCountdown ? (
              <div style={{ fontSize: 12, color: 'var(--cf-text-primary)' }}>
                将在 {this.state.countdown} 秒后自动刷新…
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--cf-text-secondary)' }}>已停止自动刷新</div>
            )}
            <button
              type="button"
              onClick={this.reloadNow}
              style={{
                fontSize: 12,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid var(--cf-border)',
                background: 'var(--cf-surface-solid)',
                color: 'var(--cf-text-primary)',
                cursor: 'pointer',
              }}
            >
              立即刷新
            </button>
            {hasCountdown ? (
              <button
                type="button"
                onClick={this.stopAutoReloadCountdown}
                style={{
                  fontSize: 12,
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--cf-border)',
                  background: 'transparent',
                  color: 'var(--cf-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                停止自动刷新
              </button>
            ) : null}
          </div>
        </div>
      );
    }
    return this.props.children as any;
  }
}
