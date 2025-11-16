// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FolderOpenDot, FileText, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import AtCommandPalette, { type PaletteLevel } from "@/components/at-mention-new/AtCommandPalette";
import type { AtCategoryId, AtItem, SearchScope } from "@/types/at";
import { getCaretViewportPosition } from "@/components/at-mention-new/caret";
import { toWSLForInsert, joinWinAbs, toWslRelOrAbsForProject } from "@/lib/wsl";
import { extractWinPathsFromDataTransfer, probeWinPathKind, preferExistingWinPathCandidate, type WinPathProbeResult } from "@/lib/dragDrop";
import {
  extractImagesFromPasteEvent,
  extractImagesFromFileList,
  isImageFileName,
  persistImages,
  dedupePastedImagesByFingerprint,
  type SavedImage,
  type PastedImage,
} from "@/lib/clipboardImages";

// PathChipsInput：用于以 Chip 形式展示/编辑图片或路径，支持：
// - 粘贴图片 -> 自动持久化并生成 Chip（含缩略图）
// - 输入 @ 触发文件搜索；选中文件 -> 生成 Chip
// - 回车确认：会将草稿按换行/逗号/分号/空白拆分为路径并生成 Chip（设计上不支持空格直接确认）
// - Backspace 在草稿为空时删除最后一个 Chip
// - 仅保留一行输入外观，自动换行展示 Chip
// 说明：组件内不将 Chip 再写回文本；向外暴露 chips 与 draft 两个受控值

export type PathChip = SavedImage & {
  // SavedImage 已包含：id、previewUrl、winPath、wslPath、fileName、fromPaste
  chipKind?: "file" | "image" | "rule";
  rulePath?: string;
};

export interface PathChipsInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  chips: PathChip[];
  onChipsChange: (next: PathChip[]) => void;
  draft: string; // 当前未生成 Chip 的文本草稿
  onDraftChange: (v: string) => void;
  /** Windows 项目根与名称（用于持久化图片归档） */
  winRoot?: string;
  /** 项目的 WSL 根路径（绝对 WSL 路径，如 /home/you/project） */
  projectWslRoot?: string;
  projectName?: string;
  /** 项目内路径样式：absolute=全路径；relative=相对路径（相对项目根） */
  projectPathStyle?: 'absolute' | 'relative';
  /** 是否渲染为“多行区域”的外观与高度（保持原 UI 习惯） */
  multiline?: boolean;
  /** 运行环境：决定鼠标悬停时 title 显示路径风格（windows 显示 Windows 路径；wsl 显示 WSL 路径） */
  runEnv?: 'wsl' | 'windows';
  /** 自定义草稿输入区域（textarea/input）的附加类名 */
  draftInputClassName?: string;
  /** 是否为滚动条预留左右对称边距，仅在全屏输入时开启以保持视觉等宽 */
  balancedScrollbarGutter?: boolean;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLikelyPath(s: string): boolean {
  const v = String(s || "").trim();
  if (!v) return false;
  // Windows 盘符、UNC、WSL、常见 POSIX 起始
  return /(^[a-zA-Z]:\\)|(^\\\\)|(^\/mnt\/)|(^\/(home|usr)\/)/.test(v);
}

// 判断相对路径或文件名是否足够像“路径”
function isLikelyRelativePath(s: string): boolean {
  const v = String(s || "").trim();
  if (!v) return false;
  if (/^\.{1,2}([\\\/]|$)/.test(v)) {
    return v.length > 1; // "./"、"../" 开头视作相对路径
  }
  if (/[\\\/]/.test(v)) {
    return true; // 含目录分隔符
  }
  if (/\s/.test(v)) return false;
  const base = v.split(/[\\\/]/).pop() || "";
  if (!base || base === "." || base === "..") return false;
  if (base.startsWith(".") && base.length > 1 && /^[A-Za-z0-9._-]+$/.test(base)) {
    return true; // .gitignore / .env 等
  }
  if (!base.includes(".")) return false;
  const parts = base.split(".");
  const ext = parts.pop() || "";
  const name = parts.join(".");
  if (!name || !ext) return false;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(ext)) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

// 从草稿中“@查询”替换为指定文本（不保留 @）
function replaceAtQuery(text: string, caret: number, insert: string): { next: string; nextCaret: number } {
  const left = text.slice(0, caret);
  const right = text.slice(caret);
  const idx = left.lastIndexOf("@");
  if (idx < 0) return { next: text, nextCaret: caret };
  const beforeAt = left.slice(0, idx);
  const next = beforeAt + insert + right;
  const nextCaret = (beforeAt + insert).length;
  return { next, nextCaret };
}

function shouldTriggerAt(text: string, caret: number): boolean {
  // 更严格的触发条件：
  // 1) 仅当光标左侧存在一个未“闭合”的 @ 段（中间无空白/分隔符）时触发；
  // 2) 若 @ 之前紧接着为路径/邮箱等连续字符（字母数字/下划线/点/斜杠/反斜杠/连字符），视为字面量 @，不触发。
  const left = text.slice(0, caret);
  const idx = left.lastIndexOf("@");
  if (idx < 0) return false;
  const seg = left.slice(idx + 1);
  // 若 @ 后到光标间包含空白或常见分隔符，则认为该 @ 段已结束，不触发
  if (/[,;，；、()（）\[\]{}\s]/.test(seg)) return false;
  // 若 @ 前一字符是连续的“词/路径”字符，认为是字面量上下文（邮箱、路径等），不触发
  const prev = idx > 0 ? left[idx - 1] : "";
  if (prev && /[A-Za-z0-9_\.\-\/\\]/.test(prev)) return false;
  // 允许在开头或空白/部分标点后直接输入 @ 触发
  return true;
}

function buildChipStableKey(chip: PathChip, fallback: string): string {
  try {
    const c = chip as any;
    const candidates = [c.id, c.previewUrl, c.wslPath, c.winPath, c.fileName];
    for (const item of candidates) {
      if (item && String(item).length > 0) return String(item);
    }
  } catch {}
  return fallback;
}

// 基于路径的去重键：优先使用 Windows 路径（不区分大小写），其次使用 WSL 路径
function normalizeWindowsPathForDedupe(p: string): string {
  try {
    let s = String(p || "");
    if (!s) return s;
    s = s.replace(/\//g, "\\");
    if (s.startsWith("\\\\")) {
      // UNC：移除末尾多余分隔符，转小写比较
      s = s.replace(/[\\/]+$/, "");
      return s.toLowerCase();
    }
    const m = s.match(/^([a-zA-Z]):(.*)$/);
    if (m) {
      const drive = m[1].toUpperCase();
      let rest = m[2];
      if (!rest || rest === "\\" || rest === "/") return `${drive}:\\`;
      rest = rest.replace(/[\\/]+$/, "");
      return `${drive}:${rest}`.toLowerCase();
    }
    return s.replace(/[\\/]+$/, "").toLowerCase();
  } catch { return String(p || ""); }
}

function normalizeWslPathForDedupe(p: string): string {
  try {
    let s = String(p || "");
    if (!s) return s;
    // 统一 POSIX 分隔符，移除多余结尾分隔符（保留根 "/"）
    s = s.replace(/\\/g, "/");
    if (s !== "/") s = s.replace(/\/+$/, "");
    return s;
  } catch { return String(p || ""); }
}

function buildChipDedupeKey(chip: Partial<PathChip>): string {
  try {
    const wp = String((chip as any)?.winPath || "").trim();
    const wsl = String((chip as any)?.wslPath || "").trim();
    if (wp) return `win:${normalizeWindowsPathForDedupe(wp)}`;
    if (wsl) return `wsl:${normalizeWslPathForDedupe(wsl)}`;
    const name = String((chip as any)?.fileName || "").trim();
    return name ? `name:${name}` : "";
  } catch { return ""; }
}

const previewUrlRefCounts = new Map<string, number>();

function retainPreviewUrl(url: string) {
  try {
    if (!url || !url.startsWith("blob:")) return;
    const prev = previewUrlRefCounts.get(url) || 0;
    previewUrlRefCounts.set(url, prev + 1);
  } catch {}
}

function releasePreviewUrl(url: string) {
  try {
    if (!url || !url.startsWith("blob:")) return;
    const prev = previewUrlRefCounts.get(url);
    if (prev === undefined) return;
    if (prev <= 1) {
      previewUrlRefCounts.delete(url);
      try { URL.revokeObjectURL(url); } catch {}
    } else {
      previewUrlRefCounts.set(url, prev - 1);
    }
  } catch {}
}

export default function PathChipsInput({
  chips,
  onChipsChange,
  draft,
  onDraftChange,
  className,
  winRoot,
  projectWslRoot,
  projectName,
  projectPathStyle = 'absolute',
  multiline,
  runEnv = 'wsl',
  onKeyDown: externalOnKeyDown,
  draftInputClassName,
  balancedScrollbarGutter = false,
  ...rest
}: PathChipsInputProps) {
  const { t } = useTranslation(['common', 'history']);
  // 统一引用：支持 input 与 textarea（multiline 时渲染 textarea）
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // @ 面板状态
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<PaletteLevel>("categories");
  const [scope, setScope] = useState<SearchScope>("all");
  const [q, setQ] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; top: number; height: number } | null>(null);
  const atIndexRef = useRef<number | null>(null);
  const dismissedAtIndexRef = useRef<number | null>(null);

  // 外层容器：相对定位。为避免滚动时附件 Chip 遮挡文本，
  // 采用常规文档流展示 Chips（不再叠放在输入区域上）。
  const base = "relative w-full rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm ring-offset-[var(--cf-app-bg)] placeholder:text-[var(--cf-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/50 focus-visible:border-[var(--cf-accent)] shadow-apple-inner";
  const containerClass = cn(
    base,
    "transition-all duration-apple ease-apple select-none hover:border-[var(--cf-border-strong)] text-[var(--cf-text-primary)]",
    // 减小顶部内边距，靠近容器上边缘；保留底部内边距保证输入区呼吸感
    multiline ? "min-h-[7.5rem] pt-0.5 pb-2" : "min-h-10 pt-0.5 pb-1",
    className
  );

  // 由于 Chips 改为常规布局，不再依赖动态 padding-top；仅保留 ref 以备后用。
  const chipsRef = useRef<HTMLDivElement | null>(null);

  // 右键菜单（打开所在文件夹 / 复制路径）
  const [ctxMenu, setCtxMenu] = useState<{ show: boolean; x: number; y: number; chip?: PathChip | null }>({ show: false, x: 0, y: 0, chip: null });
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctxMenu.show) return;
    const onDown = (e: MouseEvent) => {
      try {
        const el = ctxMenuRef.current;
        if (el && e.target && el.contains(e.target as Node)) {
          return; // 点击发生在菜单内部：不关闭，允许按钮 onClick 正常触发
        }
      } catch {}
      setCtxMenu((m) => ({ ...m, show: false }));
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu((m) => ({ ...m, show: false })); };
    const onScroll = () => setCtxMenu((m) => ({ ...m, show: false }));
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    // 捕获所有滚动容器的滚动，避免错位
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [ctxMenu.show]);

  // 打开后基于菜单实际尺寸做一次边界夹持，确保不溢出视口
  useLayoutEffect(() => {
    if (!ctxMenu.show) return;
    const raf = requestAnimationFrame(() => {
      const el = ctxMenuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pad = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = ctxMenu.x;
      let ny = ctxMenu.y;
      if (nx + rect.width + pad > vw) nx = Math.max(pad, vw - rect.width - pad);
      if (ny + rect.height + pad > vh) ny = Math.max(pad, vh - rect.height - pad);
      if (nx !== ctxMenu.x || ny !== ctxMenu.y) {
        setCtxMenu((m) => ({ ...m, x: nx, y: ny }));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [ctxMenu.show, ctxMenu.x, ctxMenu.y]);

  const [hoverPreview, setHoverPreview] = useState<{ chip: PathChip; rect: DOMRect; key: string } | null>(null);
  const previewAnchorRef = useRef<HTMLElement | null>(null);
  // 记录当前使用中的 blob URL，Chip 移除时及时调用 revoke 释放内存
  const previewUrlSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prevSet = previewUrlSetRef.current;
    const nextSet = new Set<string>();
    for (const chip of chips) {
      const url = String((chip as any)?.previewUrl || "");
      if (url && url.startsWith("blob:")) {
        nextSet.add(url);
      }
    }
    for (const url of Array.from(nextSet)) {
      if (!prevSet.has(url)) {
        retainPreviewUrl(url);
      }
    }
    for (const url of Array.from(prevSet)) {
      if (!nextSet.has(url)) {
        releasePreviewUrl(url);
      }
    }
    previewUrlSetRef.current = nextSet;
  }, [chips]);
  useEffect(() => () => {
    for (const url of Array.from(previewUrlSetRef.current)) {
      releasePreviewUrl(url);
    }
    previewUrlSetRef.current.clear();
  }, []);
  const hidePreview = useCallback(() => {
    previewAnchorRef.current = null;
    setHoverPreview(null);
  }, []);
  const showPreview = useCallback((chip: PathChip, key: string, target: HTMLElement | null) => {
    if (!target) return;
    previewAnchorRef.current = target;
    setHoverPreview({ chip, rect: target.getBoundingClientRect(), key });
  }, []);
  useEffect(() => {
    if (!hoverPreview) return;
    const refresh = () => {
      const anchor = previewAnchorRef.current;
      if (!anchor || !anchor.isConnected) {
        hidePreview();
        return;
      }
      setHoverPreview((prev) => {
        if (!prev) return prev;
        const rect = anchor.getBoundingClientRect();
        const same =
          prev.rect.left === rect.left &&
          prev.rect.top === rect.top &&
          prev.rect.width === rect.width &&
          prev.rect.height === rect.height;
        if (same) return prev;
        return { ...prev, rect };
      });
    };
    refresh();
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, [hoverPreview, hidePreview]);
  useEffect(() => {
    if (!hoverPreview) return;
    const exists = chips.some((chip, idx) => buildChipStableKey(chip, String(idx)) === hoverPreview.key);
    if (!exists) hidePreview();
  }, [chips, hoverPreview, hidePreview]);

  // 将 SavedImage 转成 PathChip 并追加
  const appendChips = useCallback((items: SavedImage[]) => {
    const merged = [...chips, ...items.map((it) => ({ ...it }))];
    const seen = new Set<string>();
    const unique: PathChip[] = [];
    for (const chip of merged) {
      const k = buildChipDedupeKey(chip);
      const key = k || buildChipStableKey(chip, String(unique.length));
      const sig = `k:${key}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      unique.push(chip);
    }
    onChipsChange(unique);
  }, [chips, onChipsChange]);

  // 解析 chip 到可直接传给主进程的绝对路径：优先生成绝对 WSL 路径（以 / 开头）或 Windows 路径
  const resolveChipFullPath = useCallback((chip: any): string => {
    try {
      if (!chip) return "";
      const w = String(chip.wslPath || "").trim();
      if (w) {
        if (w.startsWith("/")) return w;
        // 相对 WSL 路径：若提供了 projectWslRoot，则拼接为绝对 WSL 路径
        if (typeof projectWslRoot === 'string' && projectWslRoot.trim().length > 0) {
          const root = projectWslRoot.replace(/\/$/, '');
          const child = w.replace(/^\/+/, '');
          return root + (child ? '/' + child : '');
        }
        // 回退：若提供了 Windows 根，则拼接为 Windows 绝对路径
        if (typeof winRoot === 'string' && winRoot.trim().length > 0) {
          return joinWinAbs(winRoot, w);
        }
        return w;
      }
      if (chip.winPath) return String(chip.winPath || '');
      return '';
    } catch { return String(chip?.wslPath || chip?.winPath || ''); }
  }, [projectWslRoot, winRoot]);

  // 解析为 Windows 绝对路径（优先用于“复制路径”）：
  // 1) 直接使用 chip.winPath
  // 2) /mnt/<drive>/x -> X:\x
  // 3) 绝对 WSL 路径且在 projectWslRoot 下 -> joinWinAbs(winRoot, rel)
  // 4) 相对 WSL 路径 -> joinWinAbs(winRoot, path)
  const resolveChipWindowsFullPath = useCallback((chip: any): string => {
    try {
      if (!chip) return "";
      const direct = String(chip.winPath || "").trim();
      if (direct) return direct;
      const wsl = String(chip.wslPath || "").trim();
      if (!wsl) return "";
      const m = wsl.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) {
        const drive = m[1].toUpperCase();
        const rest = m[2].replace(/\//g, "\\");
        return `${drive}:\\${rest}`;
      }
      if (wsl.startsWith("/")) {
        if (typeof projectWslRoot === 'string' && projectWslRoot && typeof winRoot === 'string' && winRoot) {
          const rootW = projectWslRoot.replace(/\/$/, '');
          if (wsl === rootW || wsl.startsWith(rootW + "/")) {
            const rel = wsl.slice(rootW.length).replace(/^\/+/, '');
            try { return joinWinAbs(winRoot, rel); } catch { /* ignore */ }
          }
        }
        return ""; // 无法可靠映射到 Windows
      }
      if (typeof winRoot === 'string' && winRoot) {
        try { return joinWinAbs(winRoot, wsl); } catch { return ""; }
      }
      return "";
    } catch { return ""; }
  }, [projectWslRoot, winRoot]);

  const handleChipMouseEnter = useCallback((chip: PathChip, key: string, target: HTMLElement) => {
    if (!chip?.previewUrl) return;
    showPreview(chip, key, target);
  }, [showPreview]);

  // 判定 Chip 是否目录：优先使用 isDir 标记；若无则根据路径尾部斜杠推断
  const isChipDir = useCallback((chip?: any): boolean => {
    try {
      if (!chip) return false;
      if (typeof chip.isDir === "boolean") return !!chip.isDir;
      const w = String(chip.wslPath || "");
      const p = String(chip.winPath || "");
      return /\/$/.test(w) || /\\$/.test(p);
    } catch { return false; }
  }, []);

  // 解析文件名（保留后缀）。优先使用 fileName，其次从路径尾段提取
  const resolveChipFileName = useCallback((chip?: any): string => {
    try {
      if (!chip) return "";
      const n = String(chip.fileName || "").trim();
      if (n) return n;
      const raw = String(chip.wslPath || chip.winPath || "");
      if (!raw) return "";
      const seg = raw.split(/[\/\\]/).pop() || "";
      return seg;
    } catch { return ""; }
  }, []);

  // 解析草稿为多个 token 并生成 Chip
  const commitDraftToChips = useCallback(() => {
    const raw = String(draft || "");
    const tokens = raw
      .split(/[\n,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pathTokens = tokens.filter((token) => isLikelyPath(token) || isLikelyRelativePath(token));
    if (pathTokens.length === 0) return false;
    const items: SavedImage[] = pathTokens.map((p) => {
      const isRel = !/^\//.test(p) && !/^([a-zA-Z]):\\/.test(p) && !/^\\\\/.test(p);
      const wsl = (projectPathStyle === 'absolute' && isRel && winRoot)
        ? toWSLForInsert(joinWinAbs(String(winRoot), p))
        : toWSLForInsert(p);
      return {
        id: uid(),
        blob: new Blob(),
        previewUrl: "",
        type: "text/path",
        size: 0,
        saved: true,
        winPath: /^(?:[a-zA-Z]:\\|\\\\)/.test(p) ? p : undefined,
        wslPath: wsl,
        fileName: (wsl || p).split(/[/\\]/).pop() || t('common:files.path'),
        fromPaste: false,
      } as any;
    });
    appendChips(items);
    onDraftChange("");
    return true;
  }, [draft, appendChips, onDraftChange, projectPathStyle, winRoot, t]);

  // 监听输入以触发/更新 @ 面板
  const syncQueryFromCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const curValue = String((el as HTMLInputElement).value || "");
    const caret = (el.selectionStart as number) ?? curValue.length;
    if (!shouldTriggerAt(curValue, caret)) { setOpen(false); return; }
    const left = curValue.slice(0, caret);
    const at = left.lastIndexOf("@");
    const curQ = left.slice(at + 1);
    if (dismissedAtIndexRef.current !== null && at === dismissedAtIndexRef.current && curQ.length > 0) {
      return;
    }
    if (curQ.length === 0) dismissedAtIndexRef.current = null;
    atIndexRef.current = at;
    setQ(curQ);
    setScope("all");
    setLevel(curQ.length > 0 ? "results" : "categories");
    try { setAnchor(getCaretViewportPosition(el, caret)); } catch {}
    setOpen(true);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handler = () => requestAnimationFrame(syncQueryFromCaret);
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, [syncQueryFromCaret]);

  const onKeyDown = (e: React.KeyboardEvent<any>) => {
    try { externalOnKeyDown && externalOnKeyDown(e); } catch {}
    if (e.key === "@") {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        const curValue = String((el as HTMLInputElement).value || "");
        const caret = (el.selectionStart as number) ?? curValue.length;
        const left = curValue.slice(0, caret);
        const at = left.lastIndexOf("@");
        const curQ = left.slice(at + 1);
        atIndexRef.current = at;
        dismissedAtIndexRef.current = null;
        setQ(curQ);
        setScope("all");
        setLevel("categories");
        try { setAnchor(getCaretViewportPosition(el, caret)); } catch {}
        setOpen(true);
      });
      return;
    }

    if (e.key === "Backspace" && !draft) {
      // 删除最后一个 Chip
      if (chips.length > 0) {
        e.preventDefault();
        onChipsChange(chips.slice(0, -1));
      }
      return;
    }

    // 将草稿提交为路径 Chip
    // 注意：multiline 模式下，Enter 用于换行，不拦截
    const shouldCommitByEnter = e.key === "Enter" && !multiline;
    // 设计要求：Chip 确认仅允许回车，空格等按键不得触发提交
    // 仅在 @ 面板展开时拦截提交：刻意保持此约束以避免常规输入被误转换为路径 Chip，请勿调整
    if (open && shouldCommitByEnter) {
      if (draft.trim().length === 0) return;
      const ok = commitDraftToChips();
      if (ok) e.preventDefault();
      return;
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onDraftChange(e.target.value);
  };

  const onPaste = async (e: React.ClipboardEvent<any>) => {
    try {
      const imgs = await extractImagesFromPasteEvent(e.nativeEvent as ClipboardEvent);
      if (imgs.length === 0) return; // 非图片，走默认粘贴
      e.preventDefault();
      // 先与现有 chips 基于 fingerprint 做去重：
      // - 若剪贴板图片与已有图片完全相同，则不再重复生成/保存
      // - 这样连续多次粘贴同一张图片也只会保留一份
      const unique = dedupePastedImagesByFingerprint<PastedImage>(imgs, chips as any);
      if (!unique || unique.length === 0) return;
      const saved = await persistImages(unique, winRoot, projectName);
      appendChips(saved);
    } catch {}
  };

  const handlePick = (item: AtItem) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = (el.selectionStart as number) ?? String(draft || "").length;
    let insertText = item.title;
    try {
      if (item.categoryId === "files") {
        const relOrPath = String((item as any).path || (item as any).subtitle || item.title || "");
        const isRel = !/^\//.test(relOrPath) && !/^([a-zA-Z]):\\/.test(relOrPath) && !/^\\\\/.test(relOrPath);
        const wsl = (projectPathStyle === 'absolute' && isRel && winRoot)
          ? toWSLForInsert(joinWinAbs(String(winRoot), relOrPath))
          : toWSLForInsert(relOrPath);
        // 直接生成 Chip，携带 isDir 标记，便于 Chip 渲染不同图标
        const it: SavedImage = {
          id: uid(),
          blob: new Blob(),
          previewUrl: "",
          type: "text/path",
          size: 0,
          saved: true,
          wslPath: wsl,
          fileName: wsl.split("/").pop() || t('common:files.path'),
          // 保留 item 提供的 isDir；否则根据路径尾部是否含 / 判断
          isDir: !!(item as any).isDir || /\/$/.test(wsl),
          chipKind: "file",
        } as any;
        appendChips([it]);
        // 将 @ 段落替换为空
        const { next, nextCaret } = replaceAtQuery(draft, caret, "");
        onDraftChange(next);
        requestAnimationFrame(() => { try { el.setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
        // 关闭面板
        dismissedAtIndexRef.current = atIndexRef.current;
        atIndexRef.current = null;
        setQ("");
        setOpen(false);
        return;
      }
      if (item.categoryId === "rule") {
        const relOrPath = String((item as any).path || (item as any).subtitle || item.title || "").trim();
        const isRel = !/^\//.test(relOrPath) && !/^([a-zA-Z]):\\/.test(relOrPath) && !/^\\\\/.test(relOrPath);
        let winAbs = "";
        if (isRel && winRoot) {
          try { winAbs = joinWinAbs(String(winRoot), relOrPath); } catch { winAbs = ""; }
        } else if (/^([a-zA-Z]):\\/.test(relOrPath) || /^\\\\/.test(relOrPath)) {
          winAbs = relOrPath.replace(/\//g, "\\");
        }
        const wsl = (projectPathStyle === 'absolute' && isRel && winRoot)
          ? toWSLForInsert(winAbs || joinWinAbs(String(winRoot), relOrPath))
          : toWSLForInsert(winAbs || relOrPath);
        const baseName = relOrPath.split(/[/\\]/).pop() || relOrPath;
        const chip: SavedImage = {
          id: uid(),
          blob: new Blob(),
          previewUrl: "",
          type: "text/rule",
          size: 0,
          saved: true,
          wslPath: wsl,
          winPath: winAbs || undefined,
          fileName: baseName,
          chipKind: "rule",
          rulePath: relOrPath,
        } as any;
        appendChips([chip]);
        const { next, nextCaret } = replaceAtQuery(draft, caret, "");
        onDraftChange(next);
        requestAnimationFrame(() => { try { el.setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
        dismissedAtIndexRef.current = atIndexRef.current;
        atIndexRef.current = null;
        setQ("");
        setOpen(false);
        return;
      }
    } catch {}

    // 非文件类：将选项文字插入草稿
    const { next, nextCaret } = replaceAtQuery(draft, caret, insertText);
    onDraftChange(next);
    requestAnimationFrame(() => { try { el.setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
    dismissedAtIndexRef.current = atIndexRef.current;
    atIndexRef.current = null;
    setQ("");
    setOpen(false);
  };

  const handleEnterCategory = (id: AtCategoryId) => {
    setScope(id);
    setLevel("results");
  };

  return (
    <>
      <div
        className={containerClass}
        onClick={() => { try { inputRef.current?.focus(); } catch {} }}
        onDragOver={(e) => { try { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } catch {} }}
        onDrop={async (e) => {
          try {
            e.preventDefault();
            try { e.stopPropagation(); } catch {}
            const dt = e.dataTransfer;
            if (!dt) return;

            // 拖拽图片时复用粘贴流程：持久化后生成带预览的 Chip
            let shouldSkipImagePaths = false;
            try {
              const files = dt.files;
              if (files && files.length > 0) {
                const imgs = await extractImagesFromFileList(files);
                if (imgs.length > 0) {
                  shouldSkipImagePaths = true;
                  // 先与当前 chips 基于 fingerprint 做去重，避免重复保存/生成重复图片 Chip
                  const deduped = dedupePastedImagesByFingerprint<PastedImage>(imgs, chips as any);
                  if (deduped && deduped.length > 0) {
                    const saved = await persistImages(deduped, winRoot, projectName);
                    if (saved.length > 0) appendChips(saved);
                  }
                }
              }
            } catch {}

            const listRaw = extractWinPathsFromDataTransfer(dt);
            const listBase = shouldSkipImagePaths ? listRaw.filter((wp) => !isImageFileName(wp)) : listRaw;
            // 可选增强：在原串与解码候选之间进行“存在性择优”，仅在包含 %xx 时尝试；其余保持原样
            let list: string[] = listBase;
            try {
              list = await Promise.all(listBase.map(async (wp) => {
                if (!/%[0-9a-fA-F]{2}/.test(String(wp))) return wp;
                try { return await preferExistingWinPathCandidate(wp); } catch { return wp; }
              }));
            } catch {}
            if (!list || list.length === 0) return;
            let probes: WinPathProbeResult[] = [];
            try {
              probes = await Promise.all(list.map(async (wp) => {
                try { return await probeWinPathKind(wp); } catch { return { kind: "unknown", exists: false, isDirectory: false, isFile: false }; }
              }));
            } catch {}
            const items: SavedImage[] = list.map((wp, i) => {
              const wsl = toWslRelOrAbsForProject(wp, winRoot, projectPathStyle === 'absolute' ? 'absolute' : 'relative');
              // 当 wsl 为 "."（项目根）时，展示友好的标签：回退到 Windows 路径的最后一段，而不是 "."
              const labelBase = (wsl === ".")
                ? (String(wp).split(/[/\\]/).pop() || ".")
                : ((wsl || wp).split(/[/\\]/).pop() || "");
              const probe = probes[i];
              return {
                id: uid(),
                blob: new Blob(),
                previewUrl: "",
                type: "text/path",
                size: 0,
                saved: true,
                winPath: wp,
                wslPath: wsl,
                fileName: labelBase || t('common:files.path'),
                fromPaste: false,
                isDir: probe?.kind === "directory",
              } as any;
            });
            appendChips(items);
          } catch {}
        }}
        {...rest}
      >
        {/* Chips 采用常规文档流放置在输入区上方，最小可见间隙 2px */}
        <div ref={chipsRef} className="mt-px mb-0.5 flex flex-wrap items-start gap-0.5">
          {chips.map((chip, idx) => {
            const chipKey = buildChipStableKey(chip, `${idx}`);
            const chipAny = chip as PathChip;
            const isRule = chipAny.chipKind === "rule";
            const tooltip = isRule
              ? chipAny.rulePath || chipAny.winPath || chipAny.wslPath || ""
              : (runEnv === 'windows'
                ? (resolveChipWindowsFullPath(chipAny) || String((chipAny as any)?.winPath || (chipAny as any)?.wslPath || ""))
                : String((chipAny as any)?.wslPath || (chipAny as any)?.winPath || ""));
            const ruleLabel = chipAny.rulePath?.split(/[/\\]/).pop() || chipAny.rulePath || chipAny.fileName || t('common:files.rule');
            const labelText = isRule
              ? ruleLabel
              : chip.fileName || (chip as any)?.wslPath || t('common:files.image');
            const isDir = !!(chipAny as any).isDir || (/\/$/.test(String(chip.wslPath || '')));
            const iconNode = (() => {
              if (chip.previewUrl) {
                return <img src={chip.previewUrl} className="h-3.5 w-3.5 object-cover rounded" alt={chip.fileName || t('common:files.image')} />;
              }
              if (isRule) return <ScrollText className="h-3.5 w-3.5 text-slate-600" />;
              if (isDir) return <FolderOpenDot className="h-3.5 w-3.5 text-slate-600" />;
              return <FileText className="h-3.5 w-3.5 text-slate-600" />;
            })();
            return (
              <div
                key={chipKey}
                className="group relative inline-flex items-center gap-1.5 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-1.5 py-0.5 text-xs leading-[0.875rem] shadow-apple-xs transition-all duration-apple hover:shadow-apple hover:border-[var(--cf-border-strong)]"
                title={tooltip || undefined}
                onMouseEnter={(ev) => handleChipMouseEnter(chip, chipKey, ev.currentTarget)}
                onMouseLeave={hidePreview}
                onContextMenu={(ev) => {
                  ev.preventDefault(); ev.stopPropagation();
                  setCtxMenu({ show: true, x: ev.clientX, y: ev.clientY, chip });
                }}
              >
                {iconNode}
                <span
                  className="text-[var(--cf-text-primary)] max-w-[160px] truncate font-apple-medium"
                  title={tooltip || undefined}
                >
                  {labelText}
                </span>
                <span className="ml-0.5 inline-block rounded-apple-sm bg-[var(--cf-surface-hover)] px-1 py-0.5 text-[10px] text-[var(--cf-text-secondary)] font-apple-medium">{idx + 1}</span>
                <button
                  type="button"
                  className="ml-0.5 rounded-apple-sm px-0.5 text-[var(--cf-text-secondary)] hover:text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={async (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    try {
                      if ((chip as any).fromPaste && chip.winPath) {
                        try { await (window as any).host?.images?.trash?.({ winPath: chip.winPath }); } catch {}
                      }
                    } finally {
                      const next = chips.filter((c) => c !== chip);
                      onChipsChange(next);
                    }
                  }}
                >
                  <span className="text-xs">×</span>
                </button>
              </div>
            );
          })}
        </div>

        {hoverPreview && hoverPreview.chip?.previewUrl && typeof document !== "undefined"
          ? createPortal(
              (() => {
                const { rect, chip } = hoverPreview;
                const centerX = rect.left + rect.width / 2;
                const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
                const anchorCenterY = rect.top + rect.height / 2;
                // 规则：
                // - 输入区在视口上半部分：优先向下弹出，避免被顶部吃掉（全屏模式下尤为明显）
                // - 输入区在视口下半部分：优先向上弹出，减少被底部遮挡的概率
                const preferBelow = !viewportHeight || anchorCenterY < viewportHeight * 0.5;
                const baseTop = preferBelow ? rect.bottom + 8 : rect.top - 8;
                const clampedTop = viewportHeight
                  ? Math.min(Math.max(baseTop, 24), viewportHeight - 24)
                  : baseTop;
                const top = clampedTop;
                const translateYClass = preferBelow ? "translate-y-0" : "-translate-y-full";
                return (
                  <div
                    className="fixed z-[1200] pointer-events-none"
                    style={{ left: centerX, top }}
                  >
                    <div className={cn("rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-2 shadow-apple-lg transition-opacity dark:shadow-apple-dark-lg", "-translate-x-1/2", translateYClass)}>
                      <img src={chip.previewUrl} className="block max-h-[28rem] max-w-[28rem] object-contain rounded-apple" alt={chip.fileName || t('common:files.image')} />
                    </div>
                  </div>
                );
              })(),
              document.body
            )
          : null}

        {/* 内部输入：multiline 时使用 textarea 以获得自动换行；避免长文本被截断
            同时增加 pb-10 给右下角发送按钮让位，避免遮挡最后一行。 */}
        {multiline ? (
          <textarea
            ref={inputRef as any}
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={3}
            // 说明：
            // - resize-none 禁用手动拖拽；whitespace-pre-wrap + break-words 实现中文/长词自动换行；
            // - leading-5 提升可读性；min-h 保持与容器协调；pb-10 给右下角发送按钮留出垂直空间；
            style={balancedScrollbarGutter ? ({ scrollbarGutter: 'stable both-edges' } as any) : undefined}
            className={cn(
              "block w-full min-w-[8rem] outline-none bg-[var(--cf-surface-solid)] placeholder:text-[var(--cf-text-muted)] text-[var(--cf-text-primary)] select-text resize-none whitespace-pre-wrap break-words leading-5",
              "py-0.5 pb-10 min-h-[1.5rem]",
              draftInputClassName,
            )}
            placeholder={chips.length === 0 ? (rest as any)?.placeholder : undefined}
          />
        ) : (
          <input
            ref={inputRef as any}
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onPointerDown={(e) => { try { (e.target as HTMLElement).setPointerCapture((e as any).pointerId); } catch {} }}
            placeholder={chips.length === 0 ? (rest as any)?.placeholder : undefined}
            style={balancedScrollbarGutter ? ({ scrollbarGutter: 'stable both-edges' } as any) : undefined}
            className={cn("block w-full min-w-[8rem] outline-none bg-[var(--cf-surface-solid)] placeholder:text-[var(--cf-text-muted)] text-[var(--cf-text-primary)] select-text", "h-8 py-0.5 pb-10", draftInputClassName)}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {ctxMenu.show && typeof document !== "undefined" && createPortal(
        (
          <div className="fixed z-[1300]" style={{ left: Math.round(ctxMenu.x), top: Math.round(ctxMenu.y) }} onContextMenu={(e) => e.preventDefault()}>
            <div ref={ctxMenuRef} className="min-w-[160px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple shadow-apple-lg p-1.5 text-sm text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg">
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] disabled:opacity-40 transition-all duration-apple-fast"
                disabled={!ctxMenu.chip?.winPath && !ctxMenu.chip?.wslPath}
                onClick={async () => {
                  try {
                    const chip = ctxMenu.chip as any;
                    let p = "";
                    // 优先处理 wslPath：若为绝对 WSL 路径（以 / 开头），直接使用；若为相对路径且提供了 winRoot，则拼接为 Windows 绝对路径后使用
                    if (chip?.wslPath) {
                      const w = String(chip.wslPath || "");
                      if (w.startsWith("/")) {
                        p = w;
                      } else if (typeof winRoot === 'string' && winRoot.trim().length > 0) {
                        try { p = joinWinAbs(winRoot, w); } catch { p = w; }
                      } else {
                        p = w;
                      }
                    } else if (chip?.winPath) {
                      p = String(chip.winPath || "");
                    } else {
                      p = "";
                    }
                    if (p) {
                      const isDir = !!chip?.isDir || (/\/$/.test(String(chip?.wslPath || "")) || /\\$/.test(String(p || "")));
                      if (isDir) {
                        try {
                          const res: any = await (window as any).host?.utils?.openPath?.(p);
                          if (!(res && res.ok)) { try { alert(String(t('common:files.cannotOpenPath'))); } catch {} }
                        } catch { try { alert(String(t('common:files.cannotOpenPath'))); } catch {} }
                      } else {
                        try {
                          const res: any = await (window as any).host?.utils?.showInFolder?.(p);
                          if (!(res && res.ok)) { try { alert(String(t('history:cannotOpenContaining'))); } catch {} }
                        } catch { try { alert(String(t('history:cannotOpenContaining'))); } catch {} }
                      }
                    }
                  } catch {}
                  setCtxMenu((m) => ({ ...m, show: false }));
                }}
              >
                {t('history:openContaining')}
              </button>
              {/* 复制文件名（含后缀）：仅文件显示 */}
              {!isChipDir(ctxMenu.chip) && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={async () => {
                    try {
                      const name = resolveChipFileName(ctxMenu.chip as any);
                      if (name) {
                        const res: any = await (window as any).host?.utils?.copyText?.(name);
                        if (!(res && res.ok)) {
                          try { await navigator.clipboard.writeText(name); } catch {}
                        }
                      }
                    } catch {
                      try { await navigator.clipboard.writeText(resolveChipFileName(ctxMenu.chip as any)); } catch {}
                    }
                    setCtxMenu((m) => ({ ...m, show: false }));
                  }}
                >
                  {t('common:files.copyFileNameWithExt')}
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                onClick={async () => {
                  try {
                    const fullWin = resolveChipWindowsFullPath(ctxMenu.chip as any) || String(ctxMenu.chip?.winPath || "");
                    const text = fullWin || String(ctxMenu.chip?.wslPath || ctxMenu.chip?.fileName || "");
                    const res: any = await (window as any).host?.utils?.copyText?.(text);
                    if (!(res && res.ok)) {
                      try { await navigator.clipboard.writeText(text); } catch {}
                    }
                  } catch {
                    try { await navigator.clipboard.writeText(String(ctxMenu.chip?.winPath || ctxMenu.chip?.wslPath || ctxMenu.chip?.fileName || "")); } catch {}
                  }
                  setCtxMenu((m) => ({ ...m, show: false }));
                }}
              >
                {t('history:copyPath')}
              </button>
            </div>
          </div>
        ),
        document.body
      )}

      <AtCommandPalette
        open={open}
        anchor={anchor}
        level={level}
        scope={scope}
        query={q}
        autoFocusSearch={true}
        onChangeQuery={(v) => setQ(v)}
        onClose={() => { dismissedAtIndexRef.current = atIndexRef.current; atIndexRef.current = null; setQ(""); setOpen(false); }}
        onBackToCategories={() => { setLevel("categories"); setScope("all"); }}
        onEnterCategory={handleEnterCategory}
        onPickItem={handlePick}
      />
    </>
  );
}
