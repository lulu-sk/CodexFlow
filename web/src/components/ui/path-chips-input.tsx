// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FolderOpenDot, FileText, ScrollText, Check, Copy } from "lucide-react";
import { copyTextCrossPlatform } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import AtCommandPalette, { type PaletteLevel } from "@/components/at-mention-new/AtCommandPalette";
import type { AtCategoryId, AtItem, SearchScope } from "@/types/at";
import { getCaretViewportPosition } from "@/components/at-mention-new/caret";
import { toWSLForInsert, joinWinAbs, toWslRelOrAbsForProject, toWindowsRelOrAbsForProject, isWinPathUnderRoot } from "@/lib/wsl";
import { extractWinPathsFromDataTransfer, probeWinPathKind, preferExistingWinPathCandidate, type WinPathProbeResult } from "@/lib/dragDrop";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import InteractiveImagePreview from "@/components/ui/interactive-image-preview";
import {
  extractImagesFromPasteEvent,
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
  /** 运行环境：决定鼠标悬停时 title 显示路径风格（默认 windows） */
  runEnv?: 'wsl' | 'windows' | 'pwsh';
  /** 当前输入框所属 Provider；仅 Gemini 会启用专用图片保存策略 */
  providerId?: string;
  /** 当前 WSL 发行版名称；仅 Gemini + WSL 时需要 */
  distro?: string;
  /** 自定义草稿输入区域（textarea/input）的附加类名 */
  draftInputClassName?: string;
  /** 是否为滚动条预留左右对称边距，仅在全屏输入时开启以保持视觉等宽 */
  balancedScrollbarGutter?: boolean;
  /** 拖拽添加的资源不在当前项目目录时提醒（默认开启） */
  warnOutsideProjectDrop?: boolean;
  /** 更新“目录外资源提醒”开关（用于弹窗内“一键不再提醒”即时生效） */
  onWarnOutsideProjectDropChange?: (enabled: boolean) => void | Promise<void>;
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

/**
 * 中文说明：判断当前运行环境是否属于 Windows 原生终端。
 */
function isWindowsLikeRunEnv(runEnv?: PathChipsInputProps["runEnv"]): boolean {
  return runEnv === "windows" || runEnv === "pwsh";
}

/**
 * 中文说明：判断路径是否为 Windows 绝对路径或 UNC 路径。
 */
function isAbsoluteWindowsPath(pathText: string): boolean {
  return /^([a-zA-Z]):[\\/]/.test(pathText) || /^\\\\/.test(pathText);
}

/**
 * 中文说明：将路径文本规范化为 Windows 风格，仅做字符串层面的分隔符修正与 `/mnt` 映射。
 */
function toWindowsPathText(pathText: string): string {
  const raw = String(pathText || "").trim();
  if (!raw) return "";
  const mntMatch = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch?.[1]) {
    const drive = mntMatch[1].toUpperCase();
    const rest = String(mntMatch[2] || "").replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return raw.replace(/\//g, "\\");
}

/**
 * 中文说明：根据当前终端环境与路径风格，生成应写入 Chip 的路径字段。
 * - `wsl`：保留 WSL 路径用于发送，同时尽量补充 Windows 路径便于预览与系统操作。
 * - `windows/pwsh`：优先保留 Windows 路径，避免把 Chip 文本转换成 WSL 风格。
 */
function buildChipPaths(args: {
  rawPath: string;
  runEnv?: PathChipsInputProps["runEnv"];
  winRoot?: string;
  projectPathStyle?: "absolute" | "relative";
}): { winPath?: string; wslPath?: string; pathText: string } {
  const raw = String(args.rawPath || "").trim();
  if (!raw) return { pathText: "" };

  const style = args.projectPathStyle === "absolute" ? "absolute" : "relative";
  const winRoot = String(args.winRoot || "").trim();
  const windowsLike = isWindowsLikeRunEnv(args.runEnv);
  const windowsAbs = isAbsoluteWindowsPath(raw);
  const posixAbs = raw.startsWith("/");
  const relativePath = !windowsAbs && !posixAbs;

  if (windowsLike) {
    if (windowsAbs || /^\/mnt\/[a-zA-Z]\//.test(raw)) {
      const winAbs = toWindowsPathText(raw);
      const winPath = toWindowsRelOrAbsForProject(winAbs, winRoot, style);
      const wslPath = toWslRelOrAbsForProject(winAbs, winRoot, style);
      return { winPath, wslPath, pathText: winPath };
    }
    if (posixAbs) {
      const wslPath = toWSLForInsert(raw);
      if (/^\/mnt\/[a-zA-Z]\//.test(wslPath)) {
        const mappedWinAbs = toWindowsPathText(wslPath);
        const winPath = toWindowsRelOrAbsForProject(mappedWinAbs, winRoot, style);
        return { winPath, wslPath, pathText: winPath };
      }
      return { wslPath, pathText: wslPath };
    }
    const normalizedRel = toWindowsPathText(raw);
    if (style === "absolute" && winRoot) {
      const winAbs = joinWinAbs(winRoot, normalizedRel);
      const wslPath = toWSLForInsert(winAbs);
      return { winPath: winAbs, wslPath, pathText: winAbs };
    }
    return { winPath: normalizedRel, wslPath: normalizedRel.replace(/\\/g, "/"), pathText: normalizedRel };
  }

  if (relativePath) {
    if (style === "absolute" && winRoot) {
      const winAbs = joinWinAbs(winRoot, toWindowsPathText(raw));
      const wslPath = toWSLForInsert(winAbs);
      return { winPath: winAbs, wslPath, pathText: wslPath };
    }
    const wslPath = raw.replace(/\\/g, "/");
    return { wslPath, pathText: wslPath };
  }

  const normalizedWin = windowsAbs ? toWindowsPathText(raw) : "";
  const wslPath = windowsAbs
    ? toWslRelOrAbsForProject(normalizedWin, winRoot, style)
    : toWSLForInsert(raw);
  const winPath = windowsAbs
    ? toWindowsRelOrAbsForProject(normalizedWin, winRoot, style)
    : (/^\/mnt\/[a-zA-Z]\//.test(wslPath) ? toWindowsPathText(wslPath) : undefined);
  return { winPath, wslPath, pathText: wslPath };
}

/**
 * 中文说明：按路径候选推断 Chip 类型，统一保证图片文件在 Gemini 场景下能走图片附件语义。
 */
function resolvePathChipKind(args: { fileName?: string; isImage?: boolean; chipKind?: PathChip["chipKind"] }): PathChip["chipKind"] {
  if (args.chipKind === "rule") return "rule";
  if (args.isImage) return "image";
  if (isImageFileName(args.fileName)) return "image";
  return "file";
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

const MAX_INPUT_HISTORY_ENTRIES = 120;
const TEXT_HISTORY_COALESCE_MS = 1000;

type PathChipsInputSelection = {
  start: number;
  end: number;
  direction: Exclude<HTMLInputElement["selectionDirection"], null>;
};

type PathChipsValueState = {
  draft: string;
  chips: PathChip[];
};

type PathChipsHistorySnapshot = PathChipsValueState & {
  selection: PathChipsInputSelection;
};

type PathChipsInputHistoryMergeMode = "insert" | "delete" | null;

/**
 * 中文说明：为历史记录浅拷贝单个 Chip，保留 blob / 预览 URL 等引用值。
 */
function cloneChipForHistory(chip: PathChip): PathChip {
  return { ...(chip as any) };
}

/**
 * 中文说明：为历史记录浅拷贝 Chip 列表，避免后续修改污染已记录快照。
 */
function cloneChipsForHistory(chips: PathChip[]): PathChip[] {
  return Array.isArray(chips) ? chips.map((chip) => cloneChipForHistory(chip)) : [];
}

/**
 * 中文说明：标准化 selectionDirection，统一回退到 `none`。
 */
function normalizeSelectionDirection(direction?: string | null): PathChipsInputSelection["direction"] {
  return direction === "forward" || direction === "backward" ? direction : "none";
}

/**
 * 中文说明：创建一个折叠光标选区快照。
 */
function createCollapsedSelection(position: number): PathChipsInputSelection {
  const safe = Math.max(0, Number.isFinite(position) ? Math.floor(position) : 0);
  return { start: safe, end: safe, direction: "none" };
}

/**
 * 中文说明：复制选区快照，避免对象在历史栈中被共享引用。
 */
function cloneSelectionSnapshot(selection: PathChipsInputSelection): PathChipsInputSelection {
  return {
    start: selection.start,
    end: selection.end,
    direction: normalizeSelectionDirection(selection.direction),
  };
}

/**
 * 中文说明：从输入元素读取当前选区；当元素不存在时回退到文本末尾。
 */
function captureSelectionSnapshot(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  fallbackDraft: string,
): PathChipsInputSelection {
  const textLength = String(fallbackDraft || "").length;
  if (!el) return createCollapsedSelection(textLength);
  const rawStart = typeof el.selectionStart === "number" ? el.selectionStart : textLength;
  const rawEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : rawStart;
  const start = Math.max(0, Math.min(rawStart, textLength));
  const end = Math.max(0, Math.min(rawEnd, textLength));
  return {
    start,
    end,
    direction: normalizeSelectionDirection(el.selectionDirection),
  };
}

/**
 * 中文说明：生成 Chip 列表的稳定签名，用于判断历史状态是否真正变化。
 */
function buildChipsStateSignature(chips: PathChip[]): string {
  return cloneChipsForHistory(chips)
    .map((chip, index) => {
      const chipAny = chip as any;
      return [
        buildChipStableKey(chip, String(index)),
        String(chipAny?.winPath || ""),
        String(chipAny?.wslPath || ""),
        String(chipAny?.fileName || ""),
        String(chipAny?.previewUrl || ""),
        String(chipAny?.chipKind || ""),
        String(chipAny?.rulePath || ""),
        typeof chipAny?.isDir === "boolean" ? (chipAny.isDir ? "1" : "0") : "",
        chipAny?.fromPaste ? "1" : "0",
        String(chipAny?.fingerprint || ""),
      ].join("\u241f");
    })
    .join("\u241e");
}

/**
 * 中文说明：为 `draft + chips` 生成整体签名，用于历史状态同步。
 */
function buildValueStateSignature(state: PathChipsValueState): string {
  return `${String(state.draft || "")}\u241d${buildChipsStateSignature(state.chips)}`;
}

/**
 * 中文说明：构造一条完整历史快照，包含文本、Chip 与选区信息。
 */
function buildHistorySnapshot(args: PathChipsHistorySnapshot): PathChipsHistorySnapshot {
  return {
    draft: String(args.draft || ""),
    chips: cloneChipsForHistory(args.chips),
    selection: cloneSelectionSnapshot(args.selection),
  };
}

/**
 * 中文说明：复制历史快照，便于安全写入 past / future 栈。
 */
function cloneHistorySnapshot(snapshot: PathChipsHistorySnapshot): PathChipsHistorySnapshot {
  return buildHistorySnapshot(snapshot);
}

/**
 * 中文说明：根据浏览器 inputType 推导文本合并策略，让连续输入可合并成一次撤回。
 */
function deriveHistoryMergeMode(inputType?: string): PathChipsInputHistoryMergeMode {
  const normalized = String(inputType || "");
  if (!normalized) return null;
  if (normalized.startsWith("insert")) return "insert";
  if (normalized.startsWith("delete")) return "delete";
  return null;
}

/**
 * 中文说明：判断当前按键是否为常见撤回快捷键（Ctrl/Cmd + Z）。
 */
function isUndoShortcut(event: React.KeyboardEvent<any>): boolean {
  if (event.altKey) return false;
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z";
}

/**
 * 中文说明：判断当前按键是否为常见重做快捷键（Ctrl + Y / Ctrl/Cmd + Shift + Z）。
 */
function isRedoShortcut(event: React.KeyboardEvent<any>): boolean {
  if (event.altKey) return false;
  const key = event.key.toLowerCase();
  if (event.metaKey) return event.shiftKey && key === "z";
  if (!event.ctrlKey) return false;
  return key === "y" || (event.shiftKey && key === "z");
}

/**
 * 中文说明：将 Windows 绝对路径转为 `file:///` 预览地址，供图片失效时回退显示。
 */
function toWindowsFilePreviewUrl(winPath?: string): string {
  const raw = String(winPath || "").trim();
  if (!raw) return "";
  return `file:///${raw.replace(/\\/g, "/")}`;
}

/**
 * 中文说明：判断给定 Chip 是否应按图片附件语义处理。
 */
function isImageChip(chip?: Partial<PathChip>): boolean {
  const chipAny = chip as any;
  const fileName = String(chipAny?.fileName || "").trim();
  const type = String(chipAny?.type || "").trim().toLowerCase();
  return resolvePathChipKind({
    fileName,
    isImage: type.startsWith("image/"),
    chipKind: chipAny?.chipKind,
  }) === "image";
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
  runEnv = 'windows',
  providerId,
  distro,
  onKeyDown: externalOnKeyDown,
  draftInputClassName,
  balancedScrollbarGutter = false,
  warnOutsideProjectDrop = true,
  onWarnOutsideProjectDropChange,
  ...rest
}: PathChipsInputProps) {
  const { t } = useTranslation(['common', 'history']);
  const copyFileNameLabel = String(t("common:files.copyFileNameWithExt") || "Copy");
  // 统一引用：支持 input 与 textarea（multiline 时渲染 textarea）
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const valueStateRef = useRef<PathChipsValueState>({
    draft: String(draft || ""),
    chips: cloneChipsForHistory(chips),
  });
  const historyRef = useRef<{
    past: PathChipsHistorySnapshot[];
    current: PathChipsHistorySnapshot | null;
    future: PathChipsHistorySnapshot[];
    lastRecordedAt: number;
    lastMergeMode: PathChipsInputHistoryMergeMode;
    expectedSignature: string | null;
  }>({
    past: [],
    current: null,
    future: [],
    lastRecordedAt: 0,
    lastMergeMode: null,
    expectedSignature: null,
  });

  // @ 面板状态
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<PaletteLevel>("categories");
  const [scope, setScope] = useState<SearchScope>("all");
  const [q, setQ] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; top: number; height: number } | null>(null);
  const atIndexRef = useRef<number | null>(null);
  const dismissedAtIndexRef = useRef<number | null>(null);

  const [outsideDropDialog, setOutsideDropDialog] = useState<{
    open: boolean;
    outside: string[];
    pending: { list: string[]; droppedFiles: File[] } | null;
  }>({ open: false, outside: [], pending: null });
  const [outsideDropApplying, setOutsideDropApplying] = useState(false);
  const [outsideDropDontWarnAgain, setOutsideDropDontWarnAgain] = useState(false);

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

  /**
   * 中文说明：读取当前受控值的最新镜像，避免异步流程拿到过期的 draft / chips。
   */
  const readCurrentValueState = useCallback((): PathChipsValueState => {
    const current = valueStateRef.current;
    return {
      draft: String(current?.draft || ""),
      chips: cloneChipsForHistory(current?.chips || []),
    };
  }, []);

  /**
   * 中文说明：在当前 Chip 列表基础上合并新项，并用稳定键去重。
   */
  const buildMergedChips = useCallback((items: SavedImage[]): PathChip[] => {
    const current = readCurrentValueState();
    const merged = [...current.chips, ...items.map((it) => ({ ...it }))];
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
    return unique;
  }, [readCurrentValueState]);

  /**
   * 中文说明：根据当前光标位置刷新 `@` 面板查询状态。
   */
  const syncQueryFromCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const curValue = String((el as HTMLInputElement).value || "");
    const caret = (el.selectionStart as number) ?? curValue.length;
    if (!shouldTriggerAt(curValue, caret)) {
      setOpen(false);
      return;
    }
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

  /**
   * 中文说明：在受控值刷新后恢复输入光标/选区，并同步更新 `@` 面板。
   */
  const restoreSelectionAfterRender = useCallback((selection: PathChipsInputSelection) => {
    const nextSelection = cloneSelectionSnapshot(selection);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const textLength = String((el as HTMLInputElement).value || "").length;
      const start = Math.max(0, Math.min(nextSelection.start, textLength));
      const end = Math.max(0, Math.min(nextSelection.end, textLength));
      try { el.focus(); } catch {}
      try {
        el.setSelectionRange(start, end, nextSelection.direction);
      } catch {
        try { el.setSelectionRange(start, end); } catch {}
      }
      syncQueryFromCaret();
    });
  }, [syncQueryFromCaret]);

  useEffect(() => {
    const nextState: PathChipsValueState = {
      draft: String(draft || ""),
      chips: cloneChipsForHistory(chips),
    };
    valueStateRef.current = nextState;

    const hist = historyRef.current;
    const nextSignature = buildValueStateSignature(nextState);
    const nextSnapshot = buildHistorySnapshot({
      ...nextState,
      selection: captureSelectionSnapshot(inputRef.current, nextState.draft),
    });
    if (!hist.current) {
      hist.current = nextSnapshot;
      hist.expectedSignature = nextSignature;
      return;
    }
    if (hist.expectedSignature === nextSignature) {
      hist.current = nextSnapshot;
      return;
    }
    hist.past = [];
    hist.future = [];
    hist.current = nextSnapshot;
    hist.expectedSignature = nextSignature;
    hist.lastRecordedAt = 0;
    hist.lastMergeMode = null;
  }, [chips, draft]);

  /**
   * 中文说明：统一应用一次用户编辑，把文字与 Chip 变更写入同一条撤回历史。
   */
  const applyValueChange = useCallback((
    args: { draft?: string; chips?: PathChip[]; selection?: PathChipsInputSelection },
    options?: { mergeMode?: PathChipsInputHistoryMergeMode },
  ): boolean => {
    const current = readCurrentValueState();
    const nextDraft = typeof args.draft === "string" ? args.draft : current.draft;
    const nextChips = Array.isArray(args.chips) ? cloneChipsForHistory(args.chips) : cloneChipsForHistory(current.chips);
    const nextState: PathChipsValueState = { draft: nextDraft, chips: nextChips };
    const currentSignature = buildValueStateSignature(current);
    const nextSignature = buildValueStateSignature(nextState);
    if (currentSignature === nextSignature) {
      if (args.selection) restoreSelectionAfterRender(args.selection);
      return false;
    }

    const hist = historyRef.current;
    const currentSnapshot = hist.current
      ? cloneHistorySnapshot(hist.current)
      : buildHistorySnapshot({
          ...current,
          selection: captureSelectionSnapshot(inputRef.current, current.draft),
        });
    const nextSelection = args.selection
      ? cloneSelectionSnapshot(args.selection)
      : captureSelectionSnapshot(inputRef.current, nextDraft);
    const nextSnapshot = buildHistorySnapshot({ ...nextState, selection: nextSelection });
    const mergeMode = options?.mergeMode ?? null;
    const now = Date.now();
    const canMerge = !!mergeMode
      && hist.lastMergeMode === mergeMode
      && now - hist.lastRecordedAt <= TEXT_HISTORY_COALESCE_MS
      && buildChipsStateSignature(currentSnapshot.chips) === buildChipsStateSignature(nextSnapshot.chips)
      && currentSnapshot.selection.start === currentSnapshot.selection.end
      && nextSnapshot.selection.start === nextSnapshot.selection.end;
    if (!canMerge) {
      hist.past.push(cloneHistorySnapshot(currentSnapshot));
      if (hist.past.length > MAX_INPUT_HISTORY_ENTRIES) hist.past.shift();
    }

    hist.current = cloneHistorySnapshot(nextSnapshot);
    hist.future = [];
    hist.lastRecordedAt = now;
    hist.lastMergeMode = mergeMode;
    hist.expectedSignature = nextSignature;

    const publishedChips = cloneChipsForHistory(nextChips);
    const chipsChanged = buildChipsStateSignature(current.chips) !== buildChipsStateSignature(nextChips);
    valueStateRef.current = { draft: nextDraft, chips: publishedChips };
    if (chipsChanged) onChipsChange(publishedChips);
    if (current.draft !== nextDraft) onDraftChange(nextDraft);
    restoreSelectionAfterRender(nextSelection);
    return true;
  }, [onChipsChange, onDraftChange, readCurrentValueState, restoreSelectionAfterRender]);

  /**
   * 中文说明：撤回最近一次输入框编辑，统一恢复文字、Chip 与光标位置。
   */
  const undoValueChange = useCallback((): boolean => {
    const hist = historyRef.current;
    if (!hist.current) {
      const current = readCurrentValueState();
      hist.current = buildHistorySnapshot({
        ...current,
        selection: captureSelectionSnapshot(inputRef.current, current.draft),
      });
    }
    if (!hist.current || hist.past.length === 0) return false;

    const current = readCurrentValueState();
    const previousSnapshot = cloneHistorySnapshot(hist.past.pop() as PathChipsHistorySnapshot);
    hist.future.push(cloneHistorySnapshot(hist.current));
    hist.current = cloneHistorySnapshot(previousSnapshot);
    hist.expectedSignature = buildValueStateSignature({
      draft: previousSnapshot.draft,
      chips: previousSnapshot.chips,
    });
    hist.lastRecordedAt = 0;
    hist.lastMergeMode = null;

    const publishedChips = cloneChipsForHistory(previousSnapshot.chips);
    const chipsChanged = buildChipsStateSignature(current.chips) !== buildChipsStateSignature(previousSnapshot.chips);
    valueStateRef.current = { draft: previousSnapshot.draft, chips: publishedChips };
    if (chipsChanged) onChipsChange(publishedChips);
    if (current.draft !== previousSnapshot.draft) onDraftChange(previousSnapshot.draft);
    restoreSelectionAfterRender(previousSnapshot.selection);
    return true;
  }, [onChipsChange, onDraftChange, readCurrentValueState, restoreSelectionAfterRender]);

  /**
   * 中文说明：重做最近一次已撤回的输入框编辑。
   */
  const redoValueChange = useCallback((): boolean => {
    const hist = historyRef.current;
    if (!hist.current || hist.future.length === 0) return false;

    const current = readCurrentValueState();
    const nextSnapshot = cloneHistorySnapshot(hist.future.pop() as PathChipsHistorySnapshot);
    hist.past.push(cloneHistorySnapshot(hist.current));
    if (hist.past.length > MAX_INPUT_HISTORY_ENTRIES) hist.past.shift();
    hist.current = cloneHistorySnapshot(nextSnapshot);
    hist.expectedSignature = buildValueStateSignature({
      draft: nextSnapshot.draft,
      chips: nextSnapshot.chips,
    });
    hist.lastRecordedAt = 0;
    hist.lastMergeMode = null;

    const publishedChips = cloneChipsForHistory(nextSnapshot.chips);
    const chipsChanged = buildChipsStateSignature(current.chips) !== buildChipsStateSignature(nextSnapshot.chips);
    valueStateRef.current = { draft: nextSnapshot.draft, chips: publishedChips };
    if (chipsChanged) onChipsChange(publishedChips);
    if (current.draft !== nextSnapshot.draft) onDraftChange(nextSnapshot.draft);
    restoreSelectionAfterRender(nextSnapshot.selection);
    return true;
  }, [onChipsChange, onDraftChange, readCurrentValueState, restoreSelectionAfterRender]);

  /**
   * 中文说明：接管浏览器原生 historyUndo / historyRedo 事件，统一走组件历史栈。
   */
  const onBeforeInput = useCallback((event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as InputEvent | undefined;
    const inputType = String(nativeEvent?.inputType || "");
    if (inputType === "historyUndo") {
      event.preventDefault();
      undoValueChange();
      return;
    }
    if (inputType === "historyRedo") {
      event.preventDefault();
      redoValueChange();
    }
  }, [redoValueChange, undoValueChange]);

  /**
   * 将拖拽到输入框的 Windows 路径转换为 Chip 并追加（包含目录判定、图片预览与去重）。
   * 说明：该函数只处理已解析好的路径列表；DataTransfer 相关读取需在 onDrop 内完成。
   */
  const applyDroppedWinPaths = useCallback(async (list: string[], droppedFiles: File[]) => {
    try {
      if (!Array.isArray(list) || list.length === 0) return;

      let probes: WinPathProbeResult[] = [];
      try {
        probes = await Promise.all(list.map(async (wp) => {
          try { return await probeWinPathKind(wp); } catch { return { kind: "unknown", exists: false, isDirectory: false, isFile: false }; }
        }));
      } catch {}

      const current = readCurrentValueState();
      const existingKeys = new Set<string>();
      for (const chip of current.chips) {
        const k = buildChipDedupeKey(chip);
        if (k) existingKeys.add(k);
      }
      const localKeys = new Set<string>();
      const candidates = list.map((wp, i) => {
        const paths = buildChipPaths({
          rawPath: wp,
          runEnv,
          winRoot,
          projectPathStyle,
        });
        const probe = probes[i];
        const isDir = probe?.kind === "directory";
        const isImage = !isDir && isImageFileName(wp);
        // 当 pathText 为 "."（项目根）时，展示友好的标签：回退到 Windows 路径的最后一段，而不是 "."
        const labelBase = (paths.pathText === ".")
          ? (String(wp).split(/[/\\]/).pop() || ".")
          : ((paths.pathText || wp).split(/[/\\]/).pop() || "");
        const key = buildChipDedupeKey({
          winPath: paths.winPath,
          wslPath: paths.wslPath,
          fileName: labelBase,
        } as any);
        return { wp, ...paths, isDir, isImage, labelBase, key };
      }).filter((it) => {
        if (!it.key) return true;
        if (existingKeys.has(it.key)) return false;
        if (localKeys.has(it.key)) return false;
        localKeys.add(it.key);
        return true;
      });
      if (candidates.length === 0) return;

      // 预览策略：优先使用 DataTransfer.files 生成 blob URL（避免 file:// 在 dev/受限环境下被拦截）
      // 注意：仅为“最终会加入 chips 的图片”创建 blob URL，避免去重后遗留未释放的 URL
      const needImagePreviewKeys = new Set<string>();
      for (const it of candidates) {
        if (!it.isImage) continue;
        needImagePreviewKeys.add(normalizeWindowsPathForDedupe(it.wp));
      }
      const previewByWinPathKey = new Map<string, string>();
      try {
        if (needImagePreviewKeys.size > 0) {
          for (const f of droppedFiles) {
            const p = String((f as any).path || "").trim();
            if (!p) continue;
            const k = normalizeWindowsPathForDedupe(p);
            if (!needImagePreviewKeys.has(k)) continue;
            if (previewByWinPathKey.has(k)) continue;
            try {
              const url = URL.createObjectURL(f as any);
              previewByWinPathKey.set(k, url);
            } catch {}
          }
        }
      } catch {}

      const items: SavedImage[] = candidates.map((it) => {
        const previewUrl = it.isImage ? (previewByWinPathKey.get(normalizeWindowsPathForDedupe(it.wp)) || "") : "";
        const chipKind = resolvePathChipKind({ fileName: it.labelBase, isImage: it.isImage });
        return {
          id: uid(),
          blob: new Blob(),
          previewUrl,
          type: "text/path",
          size: 0,
          saved: true,
          winPath: it.winPath,
          wslPath: it.wslPath,
          fileName: it.labelBase || (it.isImage ? t('common:files.image') : t('common:files.path')),
          fromPaste: false,
          isDir: it.isDir,
          chipKind,
        } as any;
      });
      const nextChips = buildMergedChips(items);
      applyValueChange({ chips: nextChips });
    } catch {}
  }, [applyValueChange, buildMergedChips, projectPathStyle, readCurrentValueState, runEnv, t, winRoot]);

  /**
   * 打开“目录外资源提醒”弹窗，并缓存待处理的拖拽数据。
   */
  const openOutsideDropConfirm = useCallback((args: { outside: string[]; list: string[]; droppedFiles: File[] }) => {
    setOutsideDropDontWarnAgain(false);
    setOutsideDropDialog({
      open: true,
      outside: Array.isArray(args.outside) ? args.outside : [],
      pending: { list: Array.isArray(args.list) ? args.list : [], droppedFiles: Array.isArray(args.droppedFiles) ? args.droppedFiles : [] },
    });
  }, []);

  /**
   * 关闭“目录外资源提醒”弹窗并清理待处理数据。
   */
  const closeOutsideDropConfirm = useCallback(() => {
    setOutsideDropDialog({ open: false, outside: [], pending: null });
    setOutsideDropApplying(false);
    setOutsideDropDontWarnAgain(false);
  }, []);

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
      if (chip.winPath) {
        const direct = String(chip.winPath || '').trim();
        if (!direct) return "";
        if (isAbsoluteWindowsPath(direct)) return toWSLForInsert(direct);
        if (typeof winRoot === 'string' && winRoot.trim().length > 0) {
          try { return toWSLForInsert(joinWinAbs(winRoot, direct)); } catch { /* ignore */ }
        }
        return direct.replace(/\\/g, "/");
      }
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
      if (direct) {
        if (isAbsoluteWindowsPath(direct)) return toWindowsPathText(direct);
        if (typeof winRoot === 'string' && winRoot) {
          try { return joinWinAbs(winRoot, direct); } catch { /* ignore */ }
        }
        return toWindowsPathText(direct);
      }
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

  /**
   * 中文说明：按当前终端环境返回 Chip 的首选路径文本。
   */
  const resolveChipPreferredPath = useCallback((chip: any): string => {
    try {
      if (runEnv === "wsl") {
        return resolveChipFullPath(chip) || String(chip?.wslPath || chip?.winPath || "");
      }
      return resolveChipWindowsFullPath(chip) || String(chip?.winPath || chip?.wslPath || "");
    } catch {
      return String(chip?.winPath || chip?.wslPath || "");
    }
  }, [resolveChipFullPath, resolveChipWindowsFullPath, runEnv]);

  /**
   * 中文说明：解析图片 Chip 的稳定回退预览地址。
   * - 优先将相对路径补全为 Windows 绝对路径，避免 `projectPathStyle=relative` 时生成无效 `file:///`；
   * - 若无法可靠补全，则回退到原始 `winPath`。
   */
  const resolveChipImageFallbackUrl = useCallback((chip?: Partial<PathChip>): string => {
    if (!isImageChip(chip)) return "";
    const fullWinPath = resolveChipWindowsFullPath(chip as any);
    if (fullWinPath) return toWindowsFilePreviewUrl(fullWinPath);
    return toWindowsFilePreviewUrl(String((chip as any)?.winPath || ""));
  }, [resolveChipWindowsFullPath]);

  /**
   * 中文说明：解析 Chip 可用于渲染的预览地址。
   * - 仅图片 Chip 允许返回预览地址，普通文件即便带有误写的 `previewUrl` 也不会渲染成图片；
   * - 优先使用当前 `previewUrl`，再回退到稳定的磁盘 `file:///` 地址。
   */
  const resolveChipPreviewSrc = useCallback((chip?: Partial<PathChip>): string => {
    if (!isImageChip(chip)) return "";
    const previewUrl = String((chip as any)?.previewUrl || "").trim();
    if (previewUrl) return previewUrl;
    return resolveChipImageFallbackUrl(chip);
  }, [resolveChipImageFallbackUrl]);

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

  /**
   * 中文说明：复制 Chip 对应的文件名（含后缀），统一复用跨平台剪贴板封装。
   */
  const copyChipFileName = useCallback(async (chip?: PathChip): Promise<boolean> => {
    const name = resolveChipFileName(chip);
    if (!name) return false;
    return copyTextCrossPlatform(name);
  }, [resolveChipFileName]);

  /**
   * 中文说明：将当前草稿中的路径片段提交为 Chip，并清空草稿。
   */
  const commitDraftToChips = useCallback(() => {
    const current = readCurrentValueState();
    const raw = current.draft;
    const tokens = raw
      .split(/[\n,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pathTokens = tokens.filter((token) => isLikelyPath(token) || isLikelyRelativePath(token));
    if (pathTokens.length === 0) return false;
    const items: SavedImage[] = pathTokens.map((p) => {
      const paths = buildChipPaths({
        rawPath: p,
        runEnv,
        winRoot,
        projectPathStyle,
      });
      const fileName = (paths.pathText || p).split(/[/\\]/).pop() || t('common:files.path');
      const chipKind = resolvePathChipKind({ fileName });
      return {
        id: uid(),
        blob: new Blob(),
        previewUrl: "",
        type: "text/path",
        size: 0,
        saved: true,
        winPath: paths.winPath,
        wslPath: paths.wslPath,
        fileName,
        fromPaste: false,
        chipKind,
      } as any;
    });
    const nextChips = buildMergedChips(items);
    return applyValueChange({
      chips: nextChips,
      draft: "",
      selection: createCollapsedSelection(0),
    });
  }, [applyValueChange, buildMergedChips, projectPathStyle, readCurrentValueState, runEnv, t, winRoot]);

  const onKeyDown = (e: React.KeyboardEvent<any>) => {
    try { externalOnKeyDown && externalOnKeyDown(e); } catch {}
    if (e.defaultPrevented) return;
    if (isUndoShortcut(e)) {
      e.preventDefault();
      undoValueChange();
      return;
    }
    if (isRedoShortcut(e)) {
      e.preventDefault();
      redoValueChange();
      return;
    }
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

    const current = readCurrentValueState();
    if (e.key === "Backspace" && !current.draft) {
      // 删除最后一个 Chip
      if (current.chips.length > 0) {
        e.preventDefault();
        applyValueChange({
          chips: current.chips.slice(0, -1),
          selection: captureSelectionSnapshot(inputRef.current, current.draft),
        });
      }
      return;
    }

    // 将草稿提交为路径 Chip
    // 注意：multiline 模式下，Enter 用于换行，不拦截
    const shouldCommitByEnter = e.key === "Enter" && !multiline;
    // 设计要求：Chip 确认仅允许回车，空格等按键不得触发提交
    // 仅在 @ 面板展开时拦截提交：刻意保持此约束以避免常规输入被误转换为路径 Chip，请勿调整
    if (open && shouldCommitByEnter) {
      if (current.draft.trim().length === 0) return;
      const ok = commitDraftToChips();
      if (ok) e.preventDefault();
      return;
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as InputEvent | undefined;
    applyValueChange({
      draft: e.target.value,
      selection: captureSelectionSnapshot(e.target, e.target.value),
    }, {
      mergeMode: deriveHistoryMergeMode(nativeEvent?.inputType),
    });
  };

  const onPaste = async (e: React.ClipboardEvent<any>) => {
    try {
      const imgs = await extractImagesFromPasteEvent(e.nativeEvent as ClipboardEvent);
      if (imgs.length === 0) return; // 非图片，走默认粘贴
      e.preventDefault();
      // 先与现有 chips 基于 fingerprint 做去重：
      // - 若剪贴板图片与已有图片完全相同，则不再重复生成/保存
      // - 这样连续多次粘贴同一张图片也只会保留一份
      const current = readCurrentValueState();
      const unique = dedupePastedImagesByFingerprint<PastedImage>(imgs, current.chips as any);
      if (!unique || unique.length === 0) return;
      const saved = await persistImages(unique, {
        projectWinRoot: winRoot,
        projectWslRoot,
        projectName,
        providerId,
        runtimeEnv: runEnv,
        distro,
      });
      const latest = readCurrentValueState();
      const nextChips = buildMergedChips(saved);
      applyValueChange({
        chips: nextChips,
        selection: captureSelectionSnapshot(inputRef.current, latest.draft),
      });
    } catch {}
  };

  const handlePick = (item: AtItem) => {
    const el = inputRef.current;
    if (!el) return;
    const current = readCurrentValueState();
    const caret = (el.selectionStart as number) ?? current.draft.length;
    let insertText = item.title;
    try {
      if (item.categoryId === "files") {
        const relOrPath = String((item as any).path || (item as any).subtitle || item.title || "");
        const paths = buildChipPaths({
          rawPath: relOrPath,
          runEnv,
          winRoot,
          projectPathStyle,
        });
        const fileName = (paths.pathText || relOrPath).split(/[/\\]/).pop() || t('common:files.path');
        // 直接生成 Chip，携带 isDir 标记，便于 Chip 渲染不同图标
        const it: SavedImage = {
          id: uid(),
          blob: new Blob(),
          previewUrl: "",
          type: "text/path",
          size: 0,
          saved: true,
          winPath: paths.winPath,
          wslPath: paths.wslPath,
          fileName,
          // 保留 item 提供的 isDir；否则根据路径尾部是否含 / 判断
          isDir: !!(item as any).isDir || /[\/\\]$/.test(paths.pathText),
          chipKind: resolvePathChipKind({ fileName, chipKind: "file" }),
        } as any;
        // 将 @ 段落替换为空
        const nextChips = buildMergedChips([it]);
        const { next, nextCaret } = replaceAtQuery(current.draft, caret, "");
        applyValueChange({
          chips: nextChips,
          draft: next,
          selection: createCollapsedSelection(nextCaret),
        });
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
        const nextChips = buildMergedChips([chip]);
        const { next, nextCaret } = replaceAtQuery(current.draft, caret, "");
        applyValueChange({
          chips: nextChips,
          draft: next,
          selection: createCollapsedSelection(nextCaret),
        });
        dismissedAtIndexRef.current = atIndexRef.current;
        atIndexRef.current = null;
        setQ("");
        setOpen(false);
        return;
      }
    } catch {}

    // 非文件类：将选项文字插入草稿
    const { next, nextCaret } = replaceAtQuery(current.draft, caret, insertText);
    applyValueChange({
      draft: next,
      selection: createCollapsedSelection(nextCaret),
    });
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
		            // 注意：DataTransfer 在异步 await 后可能被浏览器清理；此处先快照 FileList，确保后续可生成预览
		            const droppedFiles = Array.from(dt.files || []);

		            // 关键约束：拖拽图片应直接引用原始文件路径；仅“剪贴板粘贴图片”才需要落盘生成临时资源
		            const listRaw = extractWinPathsFromDataTransfer(dt);
		            const listBase = listRaw;
	            // 可选增强：在原串与解码候选之间进行“存在性择优”，仅在包含 %xx 时尝试；其余保持原样
	            let list: string[] = listBase;
	            try {
	              list = await Promise.all(listBase.map(async (wp) => {
	                if (!/%[0-9a-fA-F]{2}/.test(String(wp))) return wp;
	                try { return await preferExistingWinPathCandidate(wp); } catch { return wp; }
	              }));
	            } catch {}
	            if (!list || list.length === 0) return;
                // 目录外资源提醒：仅在存在项目根且开关开启时触发
                try {
                  if (warnOutsideProjectDrop !== false && winRoot) {
                    const outside = list.filter((wp) => !isWinPathUnderRoot(wp, winRoot));
                    if (outside.length > 0) {
                      openOutsideDropConfirm({ outside, list, droppedFiles });
                      return;
                    }
                  }
                } catch {}

                await applyDroppedWinPaths(list, droppedFiles);
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
            const preferredPathText = isRule
              ? (resolveChipPreferredPath(chipAny) || chipAny.rulePath || "")
              : resolveChipPreferredPath(chipAny);
            const tooltip = preferredPathText;
            const ruleLabel = chipAny.rulePath?.split(/[/\\]/).pop() || chipAny.rulePath || chipAny.fileName || t('common:files.rule');
            const labelText = isRule
              ? ruleLabel
              : chip.fileName || (chip as any)?.wslPath || t('common:files.image');
            const isDir = !!(chipAny as any).isDir || (/\/$/.test(String(chip.wslPath || '')));
            const previewSrc = resolveChipPreviewSrc(chip);
            /**
             * 中文说明：统一渲染单个 Chip；若存在图片预览能力，则由共享组件注入悬停预览与点击弹窗交互。
             */
            const chipContent = (hoverTriggerProps?: { onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void }, openDialog?: () => void, imageProps?: React.ImgHTMLAttributes<HTMLImageElement>) => {
              /**
               * 中文说明：图片 Chip 支持整块左键打开大图；复制/删除等操作按钮通过 data 标记排除。
               */
              const handleChipPrimaryClick = (ev: React.MouseEvent<HTMLDivElement>) => {
                if (!previewSrc || !openDialog) return;
                const target = ev.target as HTMLElement | null;
                if (target?.closest("[data-chip-action='true']")) return;
                ev.preventDefault();
                ev.stopPropagation();
                openDialog();
              };

              return (
              <div
                key={chipKey}
                className={cn(
                  "group relative inline-flex items-center gap-1.5 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-1.5 py-0.5 text-xs leading-[0.875rem] shadow-apple-xs transition-all duration-apple hover:shadow-apple hover:border-[var(--cf-border-strong)]",
                  previewSrc ? "cursor-zoom-in" : "",
                )}
                title={tooltip || undefined}
                onMouseEnter={hoverTriggerProps?.onMouseEnter}
                onMouseLeave={hoverTriggerProps?.onMouseLeave}
                onClick={handleChipPrimaryClick}
                onContextMenu={(ev) => {
                  ev.preventDefault(); ev.stopPropagation();
                  setCtxMenu({ show: true, x: ev.clientX, y: ev.clientY, chip });
                }}
              >
                {previewSrc && imageProps ? (
                  <button
                    type="button"
                    data-chip-action="true"
                    className="shrink-0 rounded-[4px] transition-transform duration-apple-fast hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/35"
                    aria-label={t('common:files.image') as string}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      openDialog?.();
                    }}
                  >
                    <img {...imageProps} className="h-3.5 w-3.5 rounded object-cover" />
                  </button>
                ) : (
                  <>
                    {isRule ? <ScrollText className="h-3.5 w-3.5 text-slate-600" /> : null}
                    {!isRule && isDir ? <FolderOpenDot className="h-3.5 w-3.5 text-slate-600" /> : null}
                    {!isRule && !isDir ? <FileText className="h-3.5 w-3.5 text-slate-600" /> : null}
                  </>
                )}
                <span
                  className="text-[var(--cf-text-primary)] max-w-[160px] truncate font-apple-medium"
                  title={tooltip || undefined}
                >
                  {labelText}
                </span>
                {!isDir && (
                  <button
                    type="button"
                    data-chip-action="true"
                    title={copyFileNameLabel}
                    aria-label={copyFileNameLabel}
                    className="ml-0.5 rounded-apple-sm p-0.5 text-[var(--cf-text-secondary)] hover:text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast flex items-center justify-center"
                    onClick={async (ev) => {
                      ev.preventDefault(); ev.stopPropagation();
                      await copyChipFileName(chipAny);
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  data-chip-action="true"
                  className="ml-0.5 rounded-apple-sm px-0.5 text-[var(--cf-text-secondary)] hover:text-[var(--cf-text-primary)] hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try { inputRef.current?.focus(); } catch {}
                  }}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const current = readCurrentValueState();
                    if (idx < 0 || idx >= current.chips.length) return;
                    const next = current.chips.filter((_, chipIndex) => chipIndex !== idx);
                    applyValueChange({
                      chips: next,
                      selection: captureSelectionSnapshot(inputRef.current, current.draft),
                    });
                  }}
                >
                  <span className="text-xs">×</span>
                </button>
              </div>
              );
            };
            if (previewSrc) {
              return (
                <InteractiveImagePreview
                  key={chipKey}
                  src={previewSrc}
                  fallbackSrc={resolveChipImageFallbackUrl(chip)}
                  alt={chip.fileName || t('common:files.image')}
                  dialogTitle={labelText}
                  dialogDescription={undefined}
                  dialogMeta={preferredPathText ? <div className="break-all whitespace-pre-wrap">{preferredPathText}</div> : null}
                >
                  {({ hoverTriggerProps, openDialog, imageProps }) => chipContent(hoverTriggerProps, openDialog, imageProps)}
                </InteractiveImagePreview>
              );
            }
            return chipContent();
          })}
        </div>

        {/* 内部输入：multiline 时使用 textarea 以获得自动换行；避免长文本被截断
            同时增加 pb-10 给右下角发送按钮让位，避免遮挡最后一行。 */}
        {multiline ? (
          <textarea
            ref={inputRef as any}
            value={draft}
            onChange={onChange}
            onBeforeInput={onBeforeInput}
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
            onBeforeInput={onBeforeInput}
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
                    const p = resolveChipPreferredPath(chip);
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
                    await copyChipFileName(ctxMenu.chip as PathChip);
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
                    const text = resolveChipPreferredPath(ctxMenu.chip as any) || String(ctxMenu.chip?.fileName || "");
                    const res: any = await (window as any).host?.utils?.copyText?.(text);
                    if (!(res && res.ok)) {
                      try { await navigator.clipboard.writeText(text); } catch {}
                    }
                  } catch {
                    try { await navigator.clipboard.writeText(resolveChipPreferredPath(ctxMenu.chip as any) || String(ctxMenu.chip?.fileName || "")); } catch {}
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

      <Dialog
        open={outsideDropDialog.open}
        onOpenChange={(v) => {
          if (!v) closeOutsideDropConfirm();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("common:dragDrop.outsideProject.title")}</DialogTitle>
            <DialogDescription>
              {t("common:dragDrop.outsideProject.desc", { count: outsideDropDialog.outside.length })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white/60 px-3 py-2 text-xs text-slate-700 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
            <div className="mb-2 font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
              {t("common:dragDrop.outsideProject.outsideListLabel")}
            </div>
            <div className="space-y-1">
              {(outsideDropDialog.outside || []).slice(0, 6).map((p, idx) => {
                const base = String(p || "").split(/[/\\]/).pop() || String(p || "");
                return (
                  <div key={`${idx}:${base}`} className="truncate font-mono" title={String(p || "")}>
                    {base}
                  </div>
                );
              })}
              {(outsideDropDialog.outside || []).length > 6 ? (
                <div className="text-[11px] text-slate-500 dark:text-[var(--cf-text-muted)]">
                  {`+${(outsideDropDialog.outside || []).length - 6}`}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between pt-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-[var(--cf-text-secondary)]">
              <div className="relative flex h-3.5 w-3.5 items-center justify-center">
                <input
                  type="checkbox"
                  className="peer h-3.5 w-3.5 cursor-pointer appearance-none rounded border border-slate-300 bg-white/50 transition-all checked:border-[var(--cf-accent)] checked:bg-[var(--cf-accent)] hover:border-[var(--cf-accent)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--cf-accent)]/30 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]"
                  checked={outsideDropDontWarnAgain}
                  onChange={(event) => setOutsideDropDontWarnAgain(event.target.checked)}
                  disabled={outsideDropApplying}
                />
                <Check className="pointer-events-none absolute h-2.5 w-2.5 text-white opacity-0 transition-opacity peer-checked:opacity-100" />
              </div>
              <span className="select-none">{t("common:dragDrop.outsideProject.dontWarnAgain")}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button
                disabled={outsideDropApplying || !outsideDropDialog.pending}
                onClick={async () => {
                  if (!outsideDropDialog.pending) return;
                  setOutsideDropApplying(true);
                  try {
                    if (outsideDropDontWarnAgain) {
                      try { await Promise.resolve(onWarnOutsideProjectDropChange?.(false)); } catch {}
                    }
                    await applyDroppedWinPaths(outsideDropDialog.pending.list, outsideDropDialog.pending.droppedFiles);
                    closeOutsideDropConfirm();
                  } finally {
                    setOutsideDropApplying(false);
                  }
                }}
              >
                {t("common:dragDrop.outsideProject.confirm")}
              </Button>
              <Button
                variant="outline"
                onClick={closeOutsideDropConfirm}
                disabled={outsideDropApplying}
              >
                {t("common:cancel")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
