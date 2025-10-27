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

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  return <Ctx.Provider value={{ open, setOpen, triggerRef }}>{children}</Ctx.Provider>;
}

export function DropdownMenuTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactElement }) {
  const ctx = React.useContext(Ctx);
  if (!ctx) return children;
  return React.cloneElement(children, {
    ref: (node: any) => (ctx.triggerRef.current = node),
    onClick: (e: any) => {
      children.props.onClick?.(e);
      ctx.setOpen(!ctx.open);
    }
  });
}

export function DropdownMenuContent({ align = 'start', children }: { align?: 'start' | 'end'; children: React.ReactNode }) {
  const ctx = React.useContext(Ctx);
  const [style, setStyle] = React.useState<React.CSSProperties>({});
  React.useLayoutEffect(() => {
    if (!ctx?.open || !ctx.triggerRef.current) return;
    const rect = ctx.triggerRef.current.getBoundingClientRect();
    const left = align === 'end' ? rect.right - 200 : rect.left;
    setStyle({ position: 'fixed', top: rect.bottom + 6, left, width: 200, zIndex: 50 });
  }, [ctx?.open, align]);
  if (!ctx?.open) return null;
  const body = (
    <div style={style} className="rounded-md border bg-white p-1 shadow-xl">
      {children}
    </div>
  );
  return createPortal(body, document.body);
}

export function DropdownMenuItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100', className)} {...props} />;
}
export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-2 py-1.5 text-xs text-slate-500', className)} {...props} />;
}
export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-slate-200" />;
}

