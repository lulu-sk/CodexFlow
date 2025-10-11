// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { I18nextProvider } from 'react-i18next';
import i18n, { initI18n } from '@/i18n/setup';
import ErrorBoundary from '@/components/ErrorBoundary';

const root = createRoot(document.getElementById('root')!);

// 初始化 i18n 后再渲染，避免首次闪烁，并把关键阶段写入主进程日志
(async () => {
  let DIAG = false;
  try { DIAG = localStorage.getItem('CF_DIAG_LOG') === '1'; } catch {}
  if (DIAG) { try { await (window as any)?.host?.utils?.perfLog?.('renderer:boot start'); } catch {} }
  try { await initI18n(); } catch (e) { if (DIAG) { try { await (window as any)?.host?.utils?.perfLog?.('renderer:initI18n error ' + String((e as any)?.stack || e)); } catch {} } }
  if (DIAG) { try { await (window as any)?.host?.utils?.perfLog?.('renderer:render start'); } catch {} }
  root.render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </I18nextProvider>
    </React.StrictMode>
  );
  if (DIAG) { try { await (window as any)?.host?.utils?.perfLog?.('renderer:render done'); } catch {} }
})();
