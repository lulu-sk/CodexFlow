// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

type Ctx = {
  value?: string;
  setValue?: (v: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  items: React.MutableRefObject<Map<string, string>>;
};

const SelectCtx = React.createContext<Ctx | null>(null);

export function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const items = React.useRef(new Map<string, string>());
  return (
    <SelectCtx.Provider value={{ value, setValue: onValueChange, open, setOpen, items }}>{children}</SelectCtx.Provider>
  );
}

export function SelectTrigger({ children, className }: React.HTMLAttributes<HTMLButtonElement>) {
  const ctx = React.useContext(SelectCtx)!;
  return (
    <button className={cn('flex h-10 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-sm', className)} onClick={() => ctx.setOpen(!ctx.open)}>
      {children}
    </button>
  );
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const ctx = React.useContext(SelectCtx)!;
  const label = (ctx.value ? ctx.items.current.get(ctx.value) : undefined) || ctx.value;
  return <span className="truncate text-left">{label || placeholder}</span>;
}

export function SelectContent({ children }: { children: React.ReactNode }) {
  const ctx = React.useContext(SelectCtx)!;
  if (!ctx.open) return null;
  return (
    <div className="relative z-10 mt-1 w-full rounded-md border bg-white p-1 shadow">
      {children}
    </div>
  );
}

export function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  const ctx = React.useContext(SelectCtx)!;
  // 记录 value -> 可见标签 的映射，便于 SelectValue 展示中文标签
  React.useEffect(() => {
    try { ctx.items.current.set(value, typeof children === 'string' ? children : String(children)); } catch {}
  }, [value, children]);
  return (
    <div
      className={cn('cursor-pointer rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100', ctx.value === value && 'bg-slate-100')}
      onClick={() => { ctx.setValue?.(value); ctx.setOpen(false); }}
    >
      {children}
    </div>
  );
}
