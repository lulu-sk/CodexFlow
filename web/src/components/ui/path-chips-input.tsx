// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpenDot, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import AtCommandPalette, { type PaletteLevel } from "@/components/at-mention-new/AtCommandPalette";
import type { AtCategoryId, AtItem, SearchScope } from "@/types/at";
import { getCaretViewportPosition } from "@/components/at-mention-new/caret";
import { toWSLForInsert, joinWinAbs, toWslRelOrAbsForProject } from "@/lib/wsl";
import { extractWinPathsFromDataTransfer } from "@/lib/dragDrop";
import {
  extractImagesFromPasteEvent,
  persistImages,
  type SavedImage,
} from "@/lib/clipboardImages";

// PathChipsInput：用于以 Chip 形式展示/编辑图片或路径，支持：
// - 粘贴图片 -> 自动持久化并生成 Chip（含缩略图）
// - 输入 @ 触发文件搜索；选中文件 -> 生成 Chip
// - 回车/逗号/分号/空格 将草稿解析为路径并生成 Chip
// - Backspace 在草稿为空时删除最后一个 Chip
// - 仅保留一行输入外观，自动换行展示 Chip
// 说明：组件内不将 Chip 再写回文本；向外暴露 chips 与 draft 两个受控值

export type PathChip = SavedImage & {
  // SavedImage 已包含：id、previewUrl、winPath、wslPath、fileName、fromPaste
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
  // 放宽触发条件：只要光标左侧存在任意一个 @ 即可触发，避免还需输入空格
  const left = text.slice(0, caret);
  return left.lastIndexOf("@") >= 0;
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
  const base = "relative w-full rounded-md border border-slate-200 bg-white px-3 text-sm ring-offset-white placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950/10";
  const containerClass = cn(
    base,
    "transition-colors select-none",
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
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [ctxMenu.show]);

  // 将 SavedImage 转成 PathChip 并追加
  const appendChips = useCallback((items: SavedImage[]) => {
    const next = [...chips, ...items.map((it) => ({ ...it }))];
    onChipsChange(next);
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
    const pathTokens = tokens.filter(isLikelyPath);
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
        fileName: (wsl || p).split(/[/\\]/).pop() || "path",
        fromPaste: false,
      } as any;
    });
    appendChips(items);
    onDraftChange("");
    return true;
  }, [draft, appendChips, onDraftChange]);

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
    if ((e.key === "Enter" && !multiline) || e.key === "," || e.key === ";" || (e.key === " " && draft.trim().length > 0)) {
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
      const saved = await persistImages(imgs, winRoot, projectName);
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
          fileName: wsl.split("/").pop() || "file",
          // 保留 item 提供的 isDir；否则根据路径尾部是否含 / 判断
          isDir: !!(item as any).isDir || /\/$/.test(wsl),
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
            const list = extractWinPathsFromDataTransfer(e.dataTransfer);
            if (!list || list.length === 0) return;
            let checks: boolean[] = [];
            try {
              checks = await Promise.all(list.map(async (wp) => {
                try {
                  const res: any = await (window as any).host?.utils?.pathExists?.(wp, true);
                  return !!(res && res.ok && res.exists);
                } catch { return false; }
              }));
            } catch {}
            const items: SavedImage[] = list.map((wp, i) => {
              const wsl = toWslRelOrAbsForProject(wp, winRoot, projectPathStyle === 'absolute' ? 'absolute' : 'relative');
              return {
                id: uid(),
                blob: new Blob(),
                previewUrl: "",
                type: "text/path",
                size: 0,
                saved: true,
                winPath: wp,
                wslPath: wsl,
                fileName: (wsl || wp).split(/[/\\]/).pop() || "path",
                fromPaste: false,
                isDir: !!checks[i],
              } as any;
            });
            appendChips(items);
          } catch {}
        }}
        {...rest}
      >
        {/* Chips 采用常规文档流放置在输入区上方，最小可见间隙 2px */}
        <div ref={chipsRef} className="mt-px mb-0.5 flex flex-wrap items-start gap-0.5">
          {chips.map((chip, idx) => (
            <div
              key={chip.id || `${chip.wslPath}-${idx}`}
              className="group relative inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1 py-0.5 text-[12px] leading-4"
              title={runEnv === 'windows' ? (resolveChipWindowsFullPath(chip as any) || String((chip as any)?.winPath || (chip as any)?.wslPath || "")) : String((chip as any)?.wslPath || (chip as any)?.winPath || "")}
              onContextMenu={(ev) => {
                ev.preventDefault(); ev.stopPropagation();
                setCtxMenu({ show: true, x: ev.clientX, y: ev.clientY, chip });
              }}
            >
              {(() => {
                const isDir = !!(chip as any).isDir || (/\/$/.test(String(chip.wslPath || '')));
                if (chip.previewUrl) {
                  return (
                    <img src={chip.previewUrl} className="h-4 w-4 object-cover rounded" alt={chip.fileName || "img"} />
                  );
                }
                if (isDir) return <FolderOpenDot className="h-4 w-4 text-slate-600" />;
                return <FileText className="h-4 w-4 text-slate-600" />;
              })()}
              <span
                className="text-slate-700 max-w-[160px] truncate"
                title={runEnv === 'windows' ? (resolveChipWindowsFullPath(chip as any) || String((chip as any)?.winPath || (chip as any)?.wslPath || '')) : String((chip as any)?.wslPath || (chip as any)?.winPath || '')}
              >
                {chip.fileName || chip.wslPath || "image"}
              </span>
              <span className="ml-0.5 inline-block rounded bg-slate-200 px-1 text-[10px] text-slate-600">{idx + 1}</span>
              <button
                type="button"
                className="ml-1 rounded px-1 text-slate-500 hover:text-slate-900 hover:bg-slate-200"
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
                ×
              </button>

              {chip.previewUrl && (
                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="absolute z-50 left-1/2 -translate-x-1/2 bottom-full mb-2 p-1 bg-white border rounded shadow-lg">
                    <img src={chip.previewUrl} className="block max-h-[28rem] max-w-[28rem] object-contain" alt={chip.fileName || 'image'} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

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
            className={cn(
              "block w-full min-w-[8rem] outline-none bg-white placeholder:text-slate-400 select-text resize-none whitespace-pre-wrap break-words leading-5",
              "py-0.5 pb-10 min-h-[1.5rem]",
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
            className={cn("block w-full min-w-[8rem] outline-none bg-white placeholder:text-slate-400 select-text", "h-8 py-0.5 pb-10")}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {ctxMenu.show && (
        <div className="fixed z-[100]" style={{ left: ctxMenu.x, top: ctxMenu.y }} onContextMenu={(e) => e.preventDefault()}>
          <div ref={ctxMenuRef} className="min-w-[180px] rounded-md border bg-white shadow-lg p-1 text-sm">
            <button
              className="w-full text-left px-2 py-1 rounded hover:bg-slate-100 disabled:opacity-50"
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
                className="mt-0.5 w-full text-left px-2 py-1 rounded hover:bg-slate-100"
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
              className="mt-0.5 w-full text-left px-2 py-1 rounded hover:bg-slate-100"
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
