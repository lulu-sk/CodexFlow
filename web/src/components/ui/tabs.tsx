// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

type TabsContextValue = {
  value?: string;
  setValue?: (v: string) => void;
};

const TabsContext = React.createContext<TabsContextValue>({});

export function Tabs({ value, onValueChange, className, children }: { value?: string; onValueChange?: (v: string) => void; className?: string; children: React.ReactNode; }) {
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange }}>
      <div className={cn(className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1', className)} {...props} />
));
TabsList.displayName = 'TabsList';

export function TabsTrigger({ value, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  return (
    <button
      className={cn('inline-flex items-center whitespace-nowrap px-4 py-1.5 text-sm rounded-md transition', active ? 'bg-white shadow border' : 'text-slate-600 hover:bg-white/60', className)}
      onClick={(e) => { ctx.setValue?.(value); props.onClick?.(e); }}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const ctx = React.useContext(TabsContext);
  // 保留子树挂载，仅通过隐藏切换可见性，从而记忆滚动等内部状态
  const active = ctx.value === value;
  return (
    <div className={cn(active ? '' : 'hidden', className)} aria-hidden={!active}>
      {children}
    </div>
  );
}
