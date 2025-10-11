// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

export function Separator({ orientation = 'horizontal', className }: { orientation?: 'horizontal' | 'vertical'; className?: string }) {
  return (
    <div className={cn(
      'bg-slate-200',
      orientation === 'horizontal' ? 'h-px w-full' : 'w-px h-full',
      className
    )} />
  );
}

