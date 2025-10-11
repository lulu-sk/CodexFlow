// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: 'default' | 'secondary' | 'outline' }) {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs';
  const styles: Record<string, string> = {
    default: 'border-transparent bg-slate-900 text-white',
    secondary: 'border-transparent bg-slate-100 text-slate-900',
    outline: 'text-slate-900'
  };
  return <span className={cn(base, styles[variant], className)} {...props} />;
}

