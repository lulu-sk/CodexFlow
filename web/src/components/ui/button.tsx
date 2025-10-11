// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost';
  // 增加更紧凑尺寸选项供特定按钮使用
  size?: 'default' | 'sm' | 'icon' | 'xs' | 'icon-sm';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';
    const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
      default: 'bg-slate-900 text-white hover:bg-slate-800',
      secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
      outline: 'border border-slate-200 hover:bg-slate-100',
      ghost: 'hover:bg-slate-100'
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
