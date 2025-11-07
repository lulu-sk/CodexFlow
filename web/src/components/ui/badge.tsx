// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: 'default' | 'secondary' | 'outline' | 'danger' | 'success' | 'warning' | 'info' }) {
  const base = 'inline-flex items-center rounded-apple-sm border px-2.5 py-1 text-xs font-apple-medium transition-all duration-apple';
  const styles: Record<string, string> = {
    default: 'border-transparent bg-[var(--cf-accent)] text-white shadow-apple-xs',
    secondary: 'border-[var(--cf-border)] bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] shadow-apple-xs',
    outline: 'border-[var(--cf-border)] text-[var(--cf-text-primary)] bg-transparent',
    danger: 'border-transparent bg-[var(--cf-red-light)] text-[var(--cf-red)] shadow-apple-xs',
    success: 'border-transparent bg-[var(--cf-green-light)] text-[var(--cf-green)] shadow-apple-xs',
    warning: 'border-transparent bg-[var(--cf-yellow-light)] text-[var(--cf-text-primary)] shadow-apple-xs',
    info: 'border-transparent bg-[var(--cf-teal-light)] text-[var(--cf-teal)] shadow-apple-xs'
  };
  return <span className={cn(base, styles[variant], className)} {...props} />;
}

