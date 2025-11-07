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
    const base = 'inline-flex items-center justify-center rounded-apple text-sm font-apple-medium transition-all duration-apple ease-apple focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-app-bg)] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap active:scale-[0.98]';
    const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
      default: 'bg-[var(--cf-accent)] text-white hover:bg-[var(--cf-accent-hover)] shadow-apple hover:shadow-apple-md dark:shadow-apple-dark dark:hover:shadow-apple-dark-md',
      secondary: 'bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] border border-[var(--cf-border)] shadow-apple-sm hover:shadow-apple dark:shadow-apple-dark-sm dark:hover:shadow-apple-dark',
      outline: 'border border-[var(--cf-border)] text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] hover:border-[var(--cf-border-strong)]',
      ghost: 'text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text-primary)]',
      danger: 'bg-[var(--cf-red)] text-white hover:bg-[var(--cf-red-hover)] shadow-apple hover:shadow-apple-md dark:shadow-apple-dark dark:hover:shadow-apple-dark-md',
      success: 'bg-[var(--cf-green)] text-white hover:bg-[var(--cf-green-hover)] shadow-apple hover:shadow-apple-md dark:shadow-apple-dark dark:hover:shadow-apple-dark-md',
      warning: 'bg-[var(--cf-yellow)] text-[var(--cf-warning-foreground)] hover:bg-[var(--cf-yellow-hover)] shadow-apple hover:shadow-apple-md dark:shadow-apple-dark dark:hover:shadow-apple-dark-md',
      info: 'bg-[var(--cf-teal)] text-white hover:bg-[var(--cf-teal-hover)] shadow-apple hover:shadow-apple-md dark:shadow-apple-dark dark:hover:shadow-apple-dark-md'
    };
    const sizes: Record<NonNullable<ButtonProps['size']>, string> = {
      default: 'h-10 px-4 py-2',
      sm: 'h-9 px-3 text-xs',
      xs: 'h-7 px-2 text-xs',
      icon: 'h-10 w-10',
      'icon-sm': 'h-7 w-7'
    };
    return (
      <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...props} />
    );
  }
);
Button.displayName = 'Button';
