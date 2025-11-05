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
  if (!ctx || !ctx.open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => ctx.setOpen(false)} />
      <div className={cn('relative z-10 w-[520px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-app-bg)] p-6 shadow-xl text-[var(--cf-text-primary)]', className)}>{children}</div>
    </div>,
    document.body
  );
}

export function DialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-3', props.className)} {...props} />;
}
export function DialogTitle(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-lg font-semibold dark:text-[var(--cf-text-primary)]', props.className)} {...props} />;
}
export function DialogDescription(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm text-slate-600 dark:text-[var(--cf-text-secondary)]', props.className)} {...props} />;
}
