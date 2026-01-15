// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 可滚动容器（默认应用更精致的滚动条样式）。
 */
export function ScrollArea({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('cf-scroll-area overflow-auto', className)}>
      {children}
    </div>
  );
}
