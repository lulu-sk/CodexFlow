// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: 'default' | 'secondary' | 'outline' | 'danger' | 'success' | 'warning' | 'info' }) {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors';
  const styles: Record<string, string> = {
    default: 'border-transparent bg-[var(--cf-accent)] text-white',
    secondary: 'border-transparent bg-[var(--cf-surface)] text-[var(--cf-text-primary)]',
    outline: 'border-[var(--cf-border)] text-[var(--cf-text-primary)] bg-transparent',
    danger: 'border-transparent bg-[var(--cf-red)]/10 text-[var(--cf-red)] dark:bg-[var(--cf-red)]/20 dark:border-[var(--cf-red)]/30',
    success: 'border-transparent bg-[var(--cf-green)]/10 text-[var(--cf-green)] dark:bg-[var(--cf-green)]/20 dark:border-[var(--cf-green)]/30',
    warning: 'border-transparent bg-[var(--cf-yellow)]/10 text-[var(--cf-yellow)] dark:bg-[var(--cf-yellow)]/20 dark:border-[var(--cf-yellow)]/30',
    info: 'border-transparent bg-[var(--cf-teal)]/10 text-[var(--cf-teal)] dark:bg-[var(--cf-teal)]/20 dark:border-[var(--cf-teal)]/30'
  };
  return <span className={cn(base, styles[variant], className)} {...props} />;
}

