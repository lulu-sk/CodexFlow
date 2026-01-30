// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

export type ComboboxItem = {
  value: string;
  title: string;
  subtitle?: string;
  tag?: string;
  disabled?: boolean;
};

export type ComboboxGroup = {
  key: string;
  label?: string;
  items: ComboboxItem[];
};

export interface ComboboxProps {
  value?: string;
  onValueChange: (v: string) => void;
  groups: ComboboxGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  /** 中文说明：是否在触发器中展示已选项的 tag（例如：来源/类型）。 */
  showTagInTrigger?: boolean;
  className?: string;
  buttonClassName?: string;
  /** 中文说明：搜索输入框的受控值；不传则组件内部自管。 */
  searchValue?: string;
  /** 中文说明：搜索输入框变化回调（通常用于后端搜索）。 */
  onSearchValueChange?: (q: string) => void;
  /** 中文说明：可选：在搜索框有输入时，展示一个“使用该输入”的自定义条目。 */
  customEntry?: {
    title: (raw: string) => string;
    subtitle?: (raw: string) => string;
    tag?: string;
  };
  /** 中文说明：当列表为空且用户按下 Enter 时触发（用于粘贴提交号/引用并校验）。 */
  onEnterCustomValue?: (raw: string) => Promise<void> | void;
}

/**
 * 中文说明：带搜索的下拉选择框（Combobox）。
 * - 以外层 `value` 作为受控值；内部仅管理 open/search/highlight。
 * - 支持分组展示；分组在搜索时会过滤为空则隐藏。
 */
export function Combobox(props: ComboboxProps) {
  const {
    value,
    onValueChange,
    groups,
    placeholder,
    searchPlaceholder,
    emptyText,
    disabled,
    loading,
    showTagInTrigger,
    className,
    buttonClassName,
    searchValue,
    onSearchValueChange,
    customEntry,
    onEnterCustomValue,
  } = props;

  const [open, setOpen] = React.useState(false);
  const [internalQuery, setInternalQuery] = React.useState('');
  const query = typeof searchValue === 'string' ? searchValue : internalQuery;
  const [hi, setHi] = React.useState(0);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [style, setStyle] = React.useState<React.CSSProperties>({});

  const allItems = React.useMemo(() => {
    const items: ComboboxItem[] = [];
    for (const g of groups || []) {
      for (const it of g.items || []) {
        if (!it || !it.value) continue;
        items.push(it);
      }
    }
    return items;
  }, [groups]);

  const selected = React.useMemo(() => {
    const v = String(value || '').trim();
    if (!v) return null;
    return allItems.find((x) => String(x.value || '').trim() === v) || null;
  }, [allItems, value]);

  const normalizedQuery = String(query || '').trim().toLowerCase();
  const rawQuery = String(query || '').trim();
  const filteredGroups = React.useMemo(() => {
    const q = normalizedQuery;
    const match = (it: ComboboxItem) => {
      if (!q) return true;
      const hay = `${it.title || ''}\n${it.subtitle || ''}\n${it.tag || ''}\n${it.value || ''}`.toLowerCase();
      return hay.includes(q);
    };
    return (groups || [])
      .map((g) => {
        const items = (g.items || []).filter((it) => it && it.value && match(it));
        return { ...g, items };
      })
      .filter((g) => (g.items || []).length > 0);
  }, [groups, normalizedQuery]);

  const flatVisible = React.useMemo(() => {
    const list: ComboboxItem[] = [];
    for (const g of filteredGroups) {
      for (const it of g.items) list.push(it);
    }
    return list;
  }, [filteredGroups]);

  const setQuery = React.useCallback((next: string) => {
    const v = String(next ?? '');
    setHi(0);
    if (onSearchValueChange) {
      try { onSearchValueChange(v); } catch {}
      return;
    }
    setInternalQuery(v);
  }, [onSearchValueChange]);

  // 打开时聚焦搜索框
  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      try { inputRef.current?.focus(); } catch {}
      try { inputRef.current?.select(); } catch {}
    }, 0);
    return () => { try { window.clearTimeout(t); } catch {} };
  }, [open]);

  // 计算并更新弹层位置（固定定位，避免被 overflow 裁剪）
  const updatePosition = React.useCallback(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const pop = contentRef.current;
    if (!trigger || !pop) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 4;

    let left = Math.max(8, Math.min(rect.left, viewportW - rect.width - 8));
    let top = rect.bottom + gap;
    let maxHeight = Math.min(360, viewportH - top - 8);

    if (maxHeight < 180) {
      const estimatedHeight = pop.getBoundingClientRect().height || 260;
      const aboveTop = rect.top - gap - estimatedHeight;
      if (aboveTop >= 8) {
        top = Math.max(8, rect.top - gap - Math.min(estimatedHeight, 360));
        maxHeight = Math.min(360, rect.top - 8);
      }
    }

    setStyle({ position: 'fixed', left, top, width: rect.width, maxHeight, zIndex: 9999 });
  }, [open]);

  React.useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open) return;
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updatePosition]);

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | FocusEvent) => {
      const pop = contentRef.current;
      const trigger = triggerRef.current;
      if (!pop || !trigger) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (pop.contains(target)) return;
      if (trigger.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusin', onDown as any);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusin', onDown as any);
    };
  }, [open]);

  const handleSelect = React.useCallback((v: string) => {
    const next = String(v || '').trim();
    if (!next) return;
    try { onValueChange(next); } catch {}
    setOpen(false);
    setQuery('');
  }, [onValueChange, setQuery]);

  const onInputKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatVisible.length === 0) return;
      setHi((prev) => Math.min(flatVisible.length - 1, Math.max(0, prev + 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatVisible.length === 0) return;
      setHi((prev) => Math.min(flatVisible.length - 1, Math.max(0, prev - 1)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cur = flatVisible.length > 0 ? flatVisible[Math.max(0, Math.min(flatVisible.length - 1, hi))] : null;
      if (cur && !cur.disabled) {
        handleSelect(cur.value);
        return;
      }
      const raw = String(query || '').trim();
      if (raw && onEnterCustomValue) {
        try { void onEnterCustomValue(raw); } catch {}
      }
    }
  }, [flatVisible, handleSelect, hi, onEnterCustomValue, query]);

  const triggerLabel = selected ? selected.title : '';
  const triggerSub = selected ? selected.subtitle : '';
  const triggerTag = selected ? selected.tag : '';
  const triggerPlaceholder = String(placeholder || '').trim();

  return (
    <div className={cn('w-full', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm text-[var(--cf-text-primary)] transition-all duration-apple hover:border-[var(--cf-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/50 focus-visible:border-[var(--cf-accent)] shadow-apple-inner',
          buttonClassName,
          disabled && 'opacity-40 cursor-not-allowed',
          loading && !disabled && 'opacity-90'
        )}
        disabled={!!disabled}
        onClick={(e) => {
          e.preventDefault();
          if (disabled) return;
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (disabled) return;
            setOpen(true);
          }
        }}
      >
        <div className="min-w-0 flex-1">
          {triggerLabel ? (
            <div className="flex flex-col min-w-0">
              <div className="truncate text-left text-[13px] leading-tight">{triggerLabel}</div>
              {triggerSub ? <div className="truncate text-left font-mono text-[10px] text-[var(--cf-text-muted)] leading-tight">{triggerSub}</div> : null}
            </div>
          ) : (
            <div className="truncate text-left text-[var(--cf-text-muted)]">{triggerPlaceholder || ''}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showTagInTrigger && triggerTag ? (
            <div className="shrink-0 text-[10px] text-[var(--cf-text-muted)] border border-[var(--cf-border)] rounded px-1.5 py-0.5">
              {triggerTag}
            </div>
          ) : null}
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-[var(--cf-text-muted)] shrink-0" /> : <ChevronDown className="h-4 w-4 text-[var(--cf-text-muted)] shrink-0" />}
        </div>
      </button>

      {open ? createPortal(
        <div
          ref={contentRef}
          style={style}
          className="rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-2 shadow-apple-lg text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg overflow-hidden"
        >
          <div className="pb-2">
              <Input
              ref={inputRef as any}
              value={query}
              onChange={(e: any) => setQuery(String(e?.target?.value || ''))}
              placeholder={searchPlaceholder}
              className="h-8 text-xs"
              onKeyDown={onInputKeyDown}
            />
          </div>

          <ScrollArea className="max-h-[320px]">
            <div className="py-1">
              {customEntry && onEnterCustomValue && rawQuery ? (
                <button
                  type="button"
                  className="w-full rounded-apple-sm px-2 py-1.5 text-left transition-all duration-apple-fast hover:bg-[var(--cf-surface-hover)]"
                  onMouseDown={(e) => { e.preventDefault(); }}
                  onClick={() => {
                    try { void onEnterCustomValue(rawQuery); } catch {}
                    setOpen(false);
                  }}
                >
                  <div className="flex items-start gap-2">
                    <div className="pt-0.5 w-4 shrink-0">
                      <span className="inline-block h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 truncate text-[12px] leading-tight">{customEntry.title(rawQuery)}</div>
                        {customEntry.tag ? (
                          <div className="shrink-0 text-[10px] text-[var(--cf-text-muted)] border border-[var(--cf-border)] rounded px-1.5 py-0.5">
                            {customEntry.tag}
                          </div>
                        ) : null}
                      </div>
                      {customEntry.subtitle ? <div className="truncate text-[10px] text-[var(--cf-text-muted)] leading-tight">{customEntry.subtitle(rawQuery)}</div> : null}
                    </div>
                  </div>
                </button>
              ) : null}

              {filteredGroups.length === 0 ? (
                <div className="px-2 py-3 text-xs text-[var(--cf-text-muted)]">{emptyText || 'No results'}</div>
              ) : (
                filteredGroups.map((g, gi) => (
                  <div key={g.key || String(gi)}>
                    {g.label ? <div className="px-2 pt-2 pb-1 text-[10px] font-apple-semibold uppercase tracking-wider text-[var(--cf-text-muted)]">{g.label}</div> : null}
                    <div className="space-y-1">
                      {g.items.map((it) => {
                        const isSelected = String(value || '').trim() && String(value || '').trim() === String(it.value || '').trim();
                        return (
                          <button
                            key={it.value}
                            type="button"
                            disabled={!!it.disabled}
                            className={cn(
                              'w-full rounded-apple-sm px-2 py-1.5 text-left transition-all duration-apple-fast hover:bg-[var(--cf-surface-hover)]',
                              isSelected && 'bg-[var(--cf-surface-hover)]',
                              it.disabled && 'opacity-50 cursor-not-allowed'
                            )}
                            onMouseEnter={() => {
                              const idx = flatVisible.findIndex((x) => x.value === it.value);
                              if (idx >= 0) setHi(idx);
                            }}
                            onMouseDown={(e) => { e.preventDefault(); }}
                            onClick={() => handleSelect(it.value)}
                          >
                            <div className="flex items-start gap-2">
                              <div className="pt-0.5 w-4 shrink-0">
                                {isSelected ? <Check className="h-4 w-4 text-[var(--cf-accent)]" /> : <span className="inline-block h-4 w-4" />}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1 truncate text-[12px] leading-tight">{it.title}</div>
                                  {it.tag ? (
                                    <div className="shrink-0 text-[10px] text-[var(--cf-text-muted)] border border-[var(--cf-border)] rounded px-1.5 py-0.5">
                                      {it.tag}
                                    </div>
                                  ) : null}
                                </div>
                                {it.subtitle ? <div className="truncate font-mono text-[10px] text-[var(--cf-text-muted)] leading-tight">{it.subtitle}</div> : null}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>,
        document.body
      ) : null}
    </div>
  );
}
