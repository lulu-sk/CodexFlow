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
  <div ref={ref} className={cn('inline-flex items-center gap-1 rounded-apple bg-[var(--cf-surface-solid)] p-1 shadow-apple-inner', className)} {...props} />
));
TabsList.displayName = 'TabsList';

export function TabsTrigger({ value, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  return (
    <button
      className={cn(
        'group/tab relative inline-flex h-[24px] min-w-[72px] items-center gap-2 whitespace-nowrap rounded-full border border-transparent bg-transparent px-3 pr-6 text-xs font-apple-medium leading-tight text-[var(--cf-text-secondary)] transition-all duration-apple ease-apple ring-1 ring-transparent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-app-bg)]',
        active
          ? 'bg-gradient-to-b from-[var(--cf-tab-pill-active-top)] to-[var(--cf-tab-pill-active-bottom)] text-[var(--cf-text-primary)] border-[var(--cf-tab-border-strong)] ring-black/10 shadow-[0_6px_14px_rgba(15,23,42,0.12)] dark:ring-white/15 dark:shadow-[0_8px_18px_rgba(0,0,0,0.55)]'
          : 'hover:text-[var(--cf-text-primary)] hover:bg-[var(--cf-tab-pill-hover)] hover:border-[var(--cf-tab-border)] hover:ring-black/5 dark:hover:ring-white/15 shadow-[0_1px_2px_rgba(15,23,42,0.05)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.45)]',
        className
      )}
      data-state={active ? 'active' : 'inactive'}
      onClick={(e) => { ctx.setValue?.(value); props.onClick?.(e); }}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children, onContextMenu }: { value: string; className?: string; children: React.ReactNode; onContextMenu?: React.MouseEventHandler<HTMLDivElement> }) {
  const ctx = React.useContext(TabsContext);
  // 保留子树挂载，仅通过隐藏切换可见性，从而记忆滚动等内部状态
  const active = ctx.value === value;
  return (
    <div className={cn(active ? '' : 'hidden', className)} aria-hidden={!active} onContextMenu={onContextMenu}>
      {children}
    </div>
  );
}
