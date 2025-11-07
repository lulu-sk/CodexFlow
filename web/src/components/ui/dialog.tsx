// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

type Ctx = { open: boolean; setOpen: (v: boolean) => void };
const DialogContext = React.createContext<Ctx | null>(null);

export function Dialog({ open: openProp, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children: React.ReactNode }) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const open = openProp ?? uncontrolled;
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    else setUncontrolled(v);
  };
  return <DialogContext.Provider value={{ open, setOpen }}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactElement }) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return children;
  const child = React.cloneElement(children, {
    onClick: (e: any) => {
      children.props.onClick?.(e);
      ctx.setOpen(true);
    }
  });
  return child;
}

export function DialogContent({ className, children }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = React.useContext(DialogContext);
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    let raf1: number | null = null;
    let raf2: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    if (ctx?.open) {
      const hasRAF = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
      if (hasRAF) {
        // 延迟触发动画，确保初始状态先渲染
        raf1 = window.requestAnimationFrame(() => {
          raf2 = window.requestAnimationFrame(() => {
            setIsVisible(true);
          });
        });
      } else {
        // 在无 requestAnimationFrame 的环境（如单元测试）兼容处理
        fallbackTimer = setTimeout(() => {
          setIsVisible(true);
        }, 0);
      }
    } else {
      setIsVisible(false);
    }

    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
  }, [ctx?.open]);

  if (!ctx || !ctx.open) return null;
  
  return createPortal(
    <div className={cn(
      'fixed inset-0 z-50 flex items-center justify-center transition-all duration-apple-slow ease-apple',
      isVisible ? 'opacity-100' : 'opacity-0'
    )}>
      <div 
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-apple transition-all duration-apple-slow ease-apple',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={() => ctx.setOpen(false)} 
      />
      <div 
        className={cn(
          'relative z-10 w-[520px] rounded-apple-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-6 shadow-apple-xl text-[var(--cf-text-primary)] transition-all duration-apple-slow ease-apple dark:shadow-apple-dark-xl',
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4', props.className)} {...props} />;
}
export function DialogTitle(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-xl font-apple-semibold text-[var(--cf-text-primary)] mb-2', props.className)} {...props} />;
}
export function DialogDescription(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm text-[var(--cf-text-secondary)] leading-relaxed', props.className)} {...props} />;
}
