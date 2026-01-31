// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AtCategory, AtCategoryId, AtItem, SearchResult, SearchScope } from "@/types/at";
import { AT_CATEGORIES, searchAtItems, getCategoryById } from "@/lib/atSearch";
import { CaretPosition } from "./caret";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { FolderOpen, Folder, File, Puzzle, Tag, BadgeCheck, ChevronRight, FileText, FolderOpenDot, ScrollText } from "lucide-react";

// 图标解析：基于字符串名称返回具体图标
function IconByName({ name, className }: { name?: string; className?: string }) {
  const map: Record<string, React.ReactNode> = {
    FolderOpen: <FolderOpen className={className} />,
    Folder: <Folder className={className} />,
    File: <File className={className} />,
    Puzzle: <Puzzle className={className} />,
    Tag: <Tag className={className} />,
    BadgeCheck: <BadgeCheck className={className} />,
    ScrollText: <ScrollText className={className} />,
    // 新增更具区分度的文件和文件夹图标
    FolderOpenDot: <FolderOpenDot className={className} />,
    FileText: <FileText className={className} />,
  };
  return <>{map[name || "File"] || <File className={className} />}</>;
}

function highlight(text: string, q: string) {
  const query = String(q || "").trim();
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-[var(--cf-accent-light)] px-0.5 text-[var(--cf-text-primary)] dark:bg-[var(--cf-accent)]/20 dark:text-[var(--cf-accent)]">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export type PaletteLevel = "categories" | "results";

export interface AtCommandPaletteProps {
  open: boolean;
  anchor: CaretPosition | null;
  level: PaletteLevel;
  scope: SearchScope; // "all" | category
  query: string;
  autoFocusSearch?: boolean; // 仅在分类内搜索时自动聚焦
  onChangeQuery?: (v: string) => void; // 仅在分类内搜索时编辑
  onClose: () => void;
  onBackToCategories: () => void;
  onEnterCategory: (id: AtCategoryId) => void;
  onPickItem: (item: AtItem) => void;
}

export default function AtCommandPalette(props: AtCommandPaletteProps) {
  const { open, anchor, level, scope, query, autoFocusSearch, onChangeQuery, onClose, onBackToCategories, onEnterCategory, onPickItem } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useTranslation(['at']);

  // 高亮索引：分别维护两级
  const [hiCat, setHiCat] = useState(0);
  const [hiRes, setHiRes] = useState(0);

  useEffect(() => {
    if (level === "categories") setHiCat(0);
    if (level === "results") setHiRes(0);
  }, [level, scope, query]);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (level !== 'results') { setResults([]); setLoading(false); return; }
      if (!cancelled) setLoading(true);
      try {
        const list = await searchAtItems(query, scope, 30);
        if (!cancelled) setResults(list);
      } catch { if (!cancelled) setResults([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [level, scope, query]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, onClose]);

  // 键盘交互：↑/↓ 移动，Enter 选择/进入，Esc 返回/关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (level === "categories") {
        if (e.key === "ArrowDown") { e.preventDefault(); setHiCat((i) => Math.min(i + 1, AT_CATEGORIES.length - 1)); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setHiCat((i) => Math.max(i - 1, 0)); return; }
        if (e.key === "Enter") { e.preventDefault(); const c = AT_CATEGORIES[Math.max(0, Math.min(hiCat, AT_CATEGORIES.length - 1))]; if (c) onEnterCategory(c.id); return; }
        if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      } else {
        if (e.key === "ArrowDown") { e.preventDefault(); setHiRes((i) => Math.min(i + 1, Math.max(0, results.length - 1))); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setHiRes((i) => Math.max(i - 1, 0)); return; }
        if (e.key === "Enter") { e.preventDefault(); const r = results[Math.max(0, Math.min(hiRes, Math.max(0, results.length - 1)))]; if (r) onPickItem(r.item); return; }
        if (e.key === "Escape") { e.preventDefault(); onBackToCategories(); return; }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, level, hiCat, hiRes, results, onEnterCategory, onPickItem, onClose, onBackToCategories]);

  // 分类与结果区域的键盘交互由外部统一处理（document 级事件），
  // 这里只在需要时将焦点放到输入框（分类内搜索）。
  useEffect(() => {
    if (!open) return;
    if (level === "results" && scope !== "all" && autoFocusSearch && inputRef.current) {
      try { inputRef.current.focus(); } catch {}
    }
  }, [open, level, scope, autoFocusSearch]);

  // 当通过键盘改变高亮索引时，确保高亮项可见（滚动到可视区域）
  useEffect(() => {
    if (!open) return;
    try {
      const root = rootRef.current;
      if (!root) return;
      // 在面板中查找当前高亮项（使用一致的数据标记）并滚动到可视区域
      const highlighted = root.querySelector('button[data-active]') as HTMLElement | null;
      if (highlighted && typeof highlighted.scrollIntoView === 'function') {
        highlighted.scrollIntoView({ block: 'nearest' });
      }
    } catch {}
  }, [open, level, hiCat, hiRes, results.length]);

  if (!open || !anchor) return null;

  // 固定尺寸（整体收缩约 50%）：保持大小一致避免“仅两项时留出大片空白”视觉
  const PANEL_W = 360; // 结果与分类统一宽度
  const PANEL_H_RESULTS = 250; // 结果面板固定高
  const PANEL_H_CATEGORIES = 160; // 一级分类固定高
  // 智能定位：默认在输入框下方；若下方空间不足则放到上方；若左右越界则夹紧到边界内
  const viewW = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewH = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const panelW = PANEL_W;
  const panelH = (level === 'results') ? PANEL_H_RESULTS : PANEL_H_CATEGORIES;
  let left = Math.round(anchor.left);
  let top = Math.round(anchor.top + anchor.height + 4);
  // 水平夹紧
  if (left + panelW + 8 > viewW) left = Math.max(8, viewW - panelW - 8);
  if (left < 8) left = 8;
  // 垂直：若下方空间不足则上移到光标上方
  if (top + panelH + 8 > viewH) top = Math.max(8, Math.round(anchor.top - panelH - 8));

  const posStyle: React.CSSProperties = {
    position: "fixed",
    left,
    top,
    width: PANEL_W,
    zIndex: 1000,
  };

  const panel = (
    <div
      ref={rootRef}
      style={posStyle}
      className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] text-[var(--cf-text-primary)] shadow-xl backdrop-blur-[6px] select-none dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:text-[var(--cf-text-primary)] dark:shadow-[0_20px_38px_rgba(0,0,0,0.65)]"
    >
      {level === "categories" ? (
        <div className="w-full h-[160px]">
          <div className="p-2 text-xs text-[var(--cf-text-muted)] dark:text-[var(--cf-text-muted)]">{t('at:categoriesTitle')}</div>
          <ScrollArea className="h-[120px]">
            <div className="py-1">
              {AT_CATEGORIES.map((c, idx) => (
                <button
                  key={c.id}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left rounded-md transition-colors border-b border-[var(--cf-border)] last:border-0 hover:bg-[var(--cf-surface-hover)] dark:hover:bg-[var(--cf-surface-hover)] dark:border-[var(--cf-border)]",
                    idx === hiCat ? "bg-[var(--cf-surface-hover)] dark:bg-[var(--cf-surface-hover)]" : ""
                  )}
                  data-active={idx === hiCat ? '1' : undefined}
                  onMouseEnter={() => setHiCat(idx)}
                  // 使用 onMouseDown 阻止默认聚焦，从而避免抢占外部输入框的光标
                  onMouseDown={(e) => { e.preventDefault(); }}
                  onClick={() => onEnterCategory(c.id)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <IconByName name={c.icon} className="h-4 w-4 text-[var(--cf-text-secondary)]" />
                    <div className="truncate font-medium">{t(`at:category.${c.id}`) || c.name}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[var(--cf-text-muted)]" />
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>
      ) : (
        <div className="w-[360px] h-[250px]">
          <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
            <div className="text-xs text-[var(--cf-text-muted)]">
              {scope === "all" ? t('at:scopeAll') : t(`at:category.${scope as string}`)}
            </div>
          </div>
          {/* 面板仅用于展示结果列表，保留上方标题栏即可，删除多余重复标题 */}
          <ScrollArea className="h-[210px]">
            <div className="py-1">
              {results.length === 0 && (
                <div className="px-3 py-4 text-sm text-[var(--cf-text-muted)]">{loading ? t('at:loading') : t('at:noResults')}</div>
              )}
              {results.map((r, idx) => {
                const it = r.item;
                const active = idx === hiRes;
                const cat: AtCategory | undefined = getCategoryById(it.categoryId as AtCategoryId);
                return (
                  <button
                    key={`${it.categoryId}-${it.id}`}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-1.5 text-left rounded-md transition-colors border-b border-[var(--cf-border)] last:border-0 hover:bg-[var(--cf-surface-hover)] dark:hover:bg-[var(--cf-surface-hover)] dark:border-[var(--cf-border)]",
                      active ? "bg-[var(--cf-surface-hover)] dark:bg-[var(--cf-surface-hover)]" : ""
                    )}
                    data-active={active ? '1' : undefined}
                    onMouseEnter={() => setHiRes(idx)}
                    // 同样在结果项上阻止鼠标按下导致的默认聚焦行为
                    onMouseDown={(e) => { e.preventDefault(); }}
                    onClick={() => onPickItem(it)}
                  >
                    <IconByName name={it.icon || cat?.icon} className="h-4 w-4 text-[var(--cf-text-secondary)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--cf-text-primary)]">{highlight(it.title, query)}</div>
                      {it.subtitle && (
                        <div className="truncate text-xs text-[var(--cf-text-muted)]">{it.subtitle}</div>
                      )}
                    </div>
                    {/* 去除右侧的分类标签显示，按设计不需要在结果行重复展示 */}
                    <div style={{ width: 0, height: 0 }} aria-hidden />
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );

  // 使用 Portal 将面板固定渲染到 body，避免在具有 transform/filter/backdrop-filter/滚动容器的祖先下
  // 造成 position: fixed 参考系异常（全屏输入遮罩场景）。
  try {
    if (typeof document !== "undefined" && document.body) {
      return createPortal(panel, document.body);
    }
  } catch {}
  return panel;
}
