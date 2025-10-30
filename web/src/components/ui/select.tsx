// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

type Ctx = {
  value?: string;
  setValue?: (v: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  items: React.MutableRefObject<Map<string, string>>;
  /** 触发元素引用，用于定位下拉层（固定定位到视口） */
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>;
};

const SelectCtx = React.createContext<Ctx | null>(null);

export function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const items = React.useRef(new Map<string, string>());
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <SelectCtx.Provider value={{ value, setValue: onValueChange, open, setOpen, items, triggerRef }}>{children}</SelectCtx.Provider>
  );
}

export function SelectTrigger({
  children,
  className,
  disabled,
  onClick,
  type = 'button',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { disabled?: boolean }) {
  const ctx = React.useContext(SelectCtx)!;
  const ref = React.useRef<HTMLButtonElement | null>(null);
  const { onKeyDown: onKeyDownProp, ...buttonProps } = rest;
  // 同步触发元素引用到上下文，供下拉层定位使用
  React.useEffect(() => {
    ctx.triggerRef.current = ref.current;
  }, [ctx]);
  return (
    <button
      ref={ref}
      type={type}
      className={cn('flex h-10 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-sm', className, disabled && 'opacity-60 cursor-not-allowed')}
      disabled={!!disabled}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        if (!event.defaultPrevented) {
          ctx.setOpen(!ctx.open);
        }
      }}
      onKeyDown={(event) => {
        onKeyDownProp?.(event);
        if (event.defaultPrevented) {
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (disabled) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          const keys = Array.from(ctx.items.current.keys());
          if (keys.length === 0) {
            return;
          }
          const currentValue = ctx.value ?? '';
          const currentKey = typeof currentValue === 'string' ? currentValue : String(currentValue);
          const currentIndex = currentKey ? keys.findIndex((key) => key === currentKey) : -1;
          const forward = event.key === 'ArrowDown';
          let targetIndex = currentIndex;
          if (forward) {
            if (currentIndex === -1) {
              targetIndex = 0;
            } else if (currentIndex < keys.length - 1) {
              targetIndex = currentIndex + 1;
            }
          } else {
            if (currentIndex === -1) {
              targetIndex = keys.length - 1;
            } else if (currentIndex > 0) {
              targetIndex = currentIndex - 1;
            }
          }
          if (targetIndex === currentIndex) {
            return;
          }
          const nextKey = keys[targetIndex];
          if (nextKey !== undefined) {
            ctx.setValue?.(nextKey);
          }
        }
      }}
      {...buttonProps}
    >
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
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = React.useState<React.CSSProperties>({});

  // 计算并更新弹层位置（固定定位，避免被 overflow 裁剪）
  const updatePosition = React.useCallback(() => {
    if (!ctx.open) return;
    const trigger = ctx.triggerRef.current;
    const pop = contentRef.current;
    if (!trigger || !pop) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 4; // 触发器与弹层间距

    // 初步放在下方
    let left = Math.max(8, Math.min(rect.left, viewportW - rect.width - 8));
    let top = rect.bottom + gap;
    let maxHeight = Math.min(320, viewportH - top - 8);

    // 若底部空间不足，尝试放在上方
    if (maxHeight < 160) {
      const estimatedHeight = pop.getBoundingClientRect().height || 240;
      const aboveTop = rect.top - gap - estimatedHeight;
      if (aboveTop >= 8) {
        top = Math.max(8, rect.top - gap - Math.min(estimatedHeight, 320));
        maxHeight = Math.min(320, rect.top - 8);
      }
    }

    setStyle({ position: 'fixed', left, top, width: rect.width, maxHeight });
  }, [ctx.open]);

  React.useLayoutEffect(() => {
    if (!ctx.open) return;
    updatePosition();
  }, [ctx.open, updatePosition]);

  React.useEffect(() => {
    if (!ctx.open) return;
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [ctx.open, updatePosition]);

  // 点击外部关闭
  React.useEffect(() => {
    if (!ctx.open) return;
    const onDown = (e: MouseEvent | FocusEvent) => {
      const pop = contentRef.current;
      const trigger = ctx.triggerRef.current;
      if (!pop || !trigger) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (pop.contains(target)) return;
      if (trigger.contains(target)) return;
      ctx.setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusin', onDown as any);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusin', onDown as any);
    };
  }, [ctx.open, ctx]);

  // 未展开时：保持内容挂载，用于 value->label 映射
  if (!ctx.open) {
    return (
      <div className="hidden" aria-hidden>
        {children}
      </div>
    );
  }

  return createPortal(
    <div
      ref={contentRef}
      className={cn('z-[60] rounded-md border bg-white p-1 shadow-lg overflow-auto')}
      style={style}
      role="listbox"
    >
      {children}
    </div>,
    document.body
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
