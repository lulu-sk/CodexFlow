// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

const Ctx = React.createContext<{
  open: boolean;
  setOpen: (v: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
} | null>(null);

function assignNodeRef<T>(ref: React.Ref<T> | undefined | null, value: T) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<T>).current = value;
}

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  return <Ctx.Provider value={{ open, setOpen, triggerRef }}>{children}</Ctx.Provider>;
}

export function DropdownMenuTrigger({ children }: { children: React.ReactElement }) {
  const ctx = React.useContext(Ctx);
  if (!ctx) return children;
  const childRef = (children as any).ref as React.Ref<HTMLElement> | undefined;
  return React.cloneElement(children, {
    ref: (node: any) => {
      ctx.triggerRef.current = node;
      assignNodeRef(childRef, node);
    },
    onClick: (e: any) => {
      children.props.onClick?.(e);
      ctx.setOpen(!ctx.open);
    }
  });
}

export function DropdownMenuContent({ align = 'start', children }: { align?: 'start' | 'end'; children: React.ReactNode }) {
  const ctx = React.useContext(Ctx);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = React.useState<React.CSSProperties>({});

  // 计算并更新弹层位置
  const updatePosition = React.useCallback(() => {
    if (!ctx?.open || !ctx.triggerRef.current || !contentRef.current) return;
    const triggerRect = ctx.triggerRef.current.getBoundingClientRect();
    const contentRect = contentRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 6;

    let left = align === 'end' ? triggerRect.right - contentRect.width : triggerRect.left;
    // 确保不超出视口右侧
    if (left + contentRect.width > viewportW - 8) {
      left = viewportW - contentRect.width - 8;
    }
    // 确保不超出视口左侧
    if (left < 8) left = 8;

    let top = triggerRect.bottom + gap;
    // 如果底部空间不足，放在上方
    if (top + contentRect.height > viewportH - 8) {
      const aboveSpace = triggerRect.top - gap;
      if (aboveSpace >= contentRect.height || aboveSpace > viewportH - triggerRect.bottom) {
        top = triggerRect.top - contentRect.height - gap;
      }
    }

    setStyle({ position: 'fixed', top, left, zIndex: 9999 });
  }, [ctx?.open, align, ctx?.triggerRef]);

  React.useLayoutEffect(() => {
    updatePosition();
  }, [ctx?.open, updatePosition]);

  // 点击外部关闭
  React.useEffect(() => {
    if (!ctx?.open) return;
    const onDown = (e: MouseEvent) => {
      const content = contentRef.current;
      const trigger = ctx.triggerRef.current;
      if (!content || !trigger) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (content.contains(target) || trigger.contains(target)) return;
      ctx.setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ctx?.open, ctx]);

  // 监听滚动和窗口调整
  React.useEffect(() => {
    if (!ctx?.open) return;
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [ctx?.open, updatePosition]);

  if (!ctx?.open) return null;

  const body = (
    <div
      ref={contentRef}
      style={style}
      className="min-w-[180px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-app-bg)] p-1 shadow-lg animate-in fade-in-0 zoom-in-95 text-[var(--cf-text-primary)]"
    >
      {children}
    </div>
  );
  return createPortal(body, document.body);
}

export function DropdownMenuItem({ className, onClick, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = React.useContext(Ctx);
  return (
    <div
      className={cn('flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface)]', className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(false);
      }}
      {...props}
    />
  );
}
export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-2 py-1.5 text-xs text-[var(--cf-text-muted)]', className)} {...props} />;
}
export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-[var(--cf-border)]" />;
}

