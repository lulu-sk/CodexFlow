// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message?: string };

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any): State {
    return { hasError: true, message: String(error?.message || error) };
  }

  componentDidCatch(error: any, info: any) {
    try {
      (window as any)?.host?.utils?.perfLog?.(`[ErrorBoundary] ${String(error?.stack || error)} | info=${JSON.stringify(info)}`);
    } catch {}
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>渲染出错（已记录日志）</div>
          <div style={{ fontSize: 12, color: '#475569' }}>{this.state.message}</div>
        </div>
      );
    }
    return this.props.children as any;
  }
}

