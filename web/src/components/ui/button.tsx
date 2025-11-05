// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success' | 'warning' | 'info';
  // 增加更紧凑尺寸选项供特定按钮使用
  size?: 'default' | 'sm' | 'icon' | 'xs' | 'icon-sm';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-[var(--cf-app-bg)] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';
    const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
      default: 'bg-slate-800 text-white hover:bg-slate-900 dark:bg-[var(--cf-accent)] dark:text-white dark:hover:bg-[var(--cf-accent-hover)]',
      secondary: 'bg-[var(--cf-surface)] text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] border border-[var(--cf-border)]',
      outline: 'border border-[var(--cf-border)] text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface)]',
      ghost: 'text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface)]',
      danger: 'bg-[var(--cf-red)] text-white hover:bg-[var(--cf-red-hover)]',
      success: 'bg-[var(--cf-green)] text-white hover:bg-[var(--cf-green-hover)]',
      warning: 'bg-[var(--cf-yellow)] text-white hover:bg-[var(--cf-yellow-hover)]',
      info: 'bg-[var(--cf-teal)] text-white hover:bg-[var(--cf-teal-hover)]'
    };
    const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
      default: 'h-10 px-4 py-2',
      sm: 'h-9 px-3',
      xs: 'h-6 px-2',
      icon: 'h-10 w-10',
      'icon-sm': 'h-6 w-6'
    };
    return (
      <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...props} />
    );
  }
);
Button.displayName = 'Button';
