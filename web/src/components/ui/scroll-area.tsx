// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 可滚动容器（默认应用更精致的滚动条样式）。
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, { className?: string; children: React.ReactNode }>(
  function ScrollArea({ className, children }, ref) {
    return (
      <div ref={ref} className={cn('cf-scroll-area overflow-auto', className)}>
        {children}
      </div>
    );
  },
);
