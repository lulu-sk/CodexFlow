// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input, type InputProps } from "@/components/ui/input";
import AtCommandPalette, { type PaletteLevel } from "./AtCommandPalette";
import type { AtCategoryId, AtItem, SearchScope } from "@/types/at";
import { setActiveFileIndexRoot } from "@/lib/atSearch";
import { toWSLForInsert, toWslRelOrAbsForProject, joinWinAbs } from "@/lib/wsl";
import { extractWinPathsFromDataTransfer } from "@/lib/dragDrop";
import { getCaretViewportPosition } from "./caret";
import { extractImagesFromPasteEvent, persistImages, insertTextAtCursor, type SavedImage, hasToken, removeToken } from "@/lib/clipboardImages";

// 文本替换：将从最近一个 @（满足触发规则）到光标处的整段（含 @）替换为给定文本
// 说明：按需求，“@XXXX” 整段需要被替换掉，@ 也不保留
function replaceAtQuery(text: string, caret: number, insert: string): { next: string; nextCaret: number } {
  const left = text.slice(0, caret);
  const right = text.slice(caret);
  // 查找最近的 @
  const idx = left.lastIndexOf("@");
  if (idx < 0) return { next: text, nextCaret: caret };
  const beforeAt = left.slice(0, idx);
  // const afterAt = left.slice(idx + 1); // 不含 @ 的查询串（仅定位，无需使用）
  // 只替换最近一次 @xxxx（直到光标），且不保留 '@'
  const next = beforeAt + insert + right;
  const nextCaret = (beforeAt + insert).length;
  return { next, nextCaret };
}

function shouldTriggerAt(text: string, caret: number): boolean {
  const left = text.slice(0, caret);
  const idx = left.lastIndexOf("@");
  if (idx < 0) return false;
  const prev = left[idx - 1];
  // 前一字符为空白/行首/标点
  if (idx === 0) return true;
  return /\s|[\(\)\[\]{}.,;:!?]/.test(prev);
}

type AtInputProps = Omit<InputProps, "onChange" | "value"> & { value: string; onValueChange: (v: string) => void; winRoot?: string; projectName?: string; projectPathStyle?: 'absolute' | 'relative' };

export function AtInput({ value, onValueChange, winRoot, projectName, projectPathStyle = 'absolute', ...rest }: AtInputProps) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<PaletteLevel>("categories");
  const [scope, setScope] = useState<SearchScope>("all");
  const [q, setQ] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; top: number; height: number } | null>(null);
  // 当前这次触发对应的 @ 字符索引（文档内位置），用于“会话抑制”
  const atIndexRef = useRef<number | null>(null);
  // 被主动关闭（选择/Esc/外点）后的会话抑制：保持到出现“新 @”或删到仅剩“@”
  const dismissedAtIndexRef = useRef<number | null>(null);
  // 粘贴图片的临时预览与保存结果（仅用于辅助用户查看）
  const [pastedImages, setPastedImages] = useState<SavedImage[]>([]);
  // 释放过期的 blob URL，避免内存泄漏
  const urlSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const nextSet = new Set<string>();
    for (const it of pastedImages) { if (it.previewUrl) nextSet.add(it.previewUrl); }
    // revoke 旧的
    for (const url of Array.from(urlSetRef.current)) {
      if (!nextSet.has(url)) {
        try { URL.revokeObjectURL(url); } catch {}
      }
    }
    urlSetRef.current = nextSet;
  }, [pastedImages]);
  // value 改变时，自动移除“正文中已不存在的图片”
  useEffect(() => {
    setPastedImages((prev) => prev.filter((img) => {
      const pathToken = String(img.wslPath || '');
      if (!pathToken) return false;
      // 认为：若正文中存在 `path` 或 裸 path，均视为“仍被引用”
      return hasToken(value, "`" + pathToken + "`") || hasToken(value, pathToken);
    }));
  }, [value]);

  // 当项目根变化时，预热/确保索引（避免首次按 @ 再初始化带来的首延迟）
  useEffect(() => {
    try { if (winRoot) setActiveFileIndexRoot(winRoot); } catch {}
  }, [winRoot]);

  function extractContext(curValue: string, caret: number): { valid: boolean; atIndex: number; q: string } | null {
    if (!shouldTriggerAt(curValue, caret)) return null;
    const left = curValue.slice(0, caret);
    const at = left.lastIndexOf("@");
    const curQ = left.slice(at + 1);
    return { valid: true, atIndex: at, q: curQ };
  }

  // 从输入值与光标位置推导当前 @ 查询串
  const syncQueryFromCaret = useCallback(() => {
    const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
    if (!el) return;
    // @ts-ignore
    const caret = (el.selectionStart as number) ?? String(value || "").length;
    const ctx = extractContext(value, caret);
    if (!ctx) { setOpen(false); return; }
    const { atIndex, q: qq } = ctx;
    // 会话抑制：若上一次被关闭的 @ 与当前仍相同且查询非空，则不重开
    if (dismissedAtIndexRef.current !== null && atIndex === dismissedAtIndexRef.current && qq.length > 0) {
      return;
    }
    // 允许重开：1) 出现新 @（索引不同）；2) 同一 @ 但已删到仅剩 @ 或本次已不再抑制
    if (qq.length === 0) { // 如果查询为空，总是解除抑制
      dismissedAtIndexRef.current = null;
    }
    atIndexRef.current = atIndex;
    setQ(qq);
    setScope("all");
    setLevel(qq.length > 0 ? "results" : "categories");
    try { setAnchor(getCaretViewportPosition(el, caret)); } catch {}
    setOpen(true);
  }, [value]);

  // 监听输入以触发/更新弹窗（包括在已打开时更新 q）
  const onLocalChange = (e: any) => {
    const nextVal = (e.target as HTMLInputElement).value;
    onValueChange(nextVal);
    requestAnimationFrame(() => {
      const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
      if (!el) return;
      // @ts-ignore
      const caret = (el.selectionStart as number) ?? String(nextVal || "").length;
      const ctx = extractContext(nextVal, caret);
      if (!ctx) {
        // @ 已被删除或不在触发位置，立即关闭面板并清理状态
        if (open) {
          dismissedAtIndexRef.current = null;
          atIndexRef.current = null;
          setQ("");
          setOpen(false);
        }
        return;
      }
      const { atIndex, q: curQ } = ctx;
      // 新 @：解除抑制并允许打开
      const isNewAt = dismissedAtIndexRef.current === null || atIndex !== dismissedAtIndexRef.current;
      // 同一 @：仅当删到仅剩 @ 时重开
      // 如果查询为空，总是解除抑制
      if (curQ.length === 0) {
        dismissedAtIndexRef.current = null;
      }
      const allowReopen = isNewAt || curQ.length === 0;
      if (!allowReopen) return;
      atIndexRef.current = atIndex;
      setQ(curQ);
      setScope("all");
      setLevel(curQ.length > 0 ? "results" : "categories");
      try { setAnchor(getCaretViewportPosition(el, caret)); } catch {}
      setOpen(true);
    });
  };

  // 监听原生 input 事件（兼容 IME），确保在输入任何字符后都能更新面板
  useEffect(() => {
    const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
    if (!el) return;
    const handler = () => requestAnimationFrame(syncQueryFromCaret);
    el.addEventListener('input', handler);
    return () => el.removeEventListener('input', handler);
  }, [syncQueryFromCaret]);

  // 该组件不处理 ↑/↓/Enter/Esc，交由面板内部统一处理（已在面板中监听 document）。

  // 在输入框内监听 @ 触发
  const onKeyDown = (e: React.KeyboardEvent<any>) => {
    if (e.key === "@") {
      requestAnimationFrame(() => {
        const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
        if (!el) return;
        // 触发 @ 时，确保已按当前项目根加载索引（若上层未触发则此处兜底）
        try { if (winRoot) setActiveFileIndexRoot(winRoot); } catch {}
        // @ts-ignore
        const caret = (el.selectionStart as number) ?? String(value || "").length;
        const left = value.slice(0, caret);
        const at = left.lastIndexOf("@");
        const curQ = left.slice(at + 1);
        atIndexRef.current = at;
        // 新 @ 输入时，解除抑制
        dismissedAtIndexRef.current = null;
        setQ(curQ);
        setScope("all");
        // 直接按下 @ 即弹出一级；若后续继续输入字符，syncQueryFromCaret 会切换为二级
        setLevel("categories");
        try { setAnchor(getCaretViewportPosition(el, caret)); } catch {}
        setOpen(true);
      });
    }
  };

  // 处理图片粘贴（借鉴 GitHub/Slack：优先识别图片项并阻止默认文本粘贴）
  const onPaste = async (e: React.ClipboardEvent<any>) => {
    try {
      const imgs = await extractImagesFromPasteEvent(e.nativeEvent as ClipboardEvent);
      if (imgs.length === 0) {
        // 兜底：若剪贴板有图片但事件中无 image 项（个别应用复制），直接从 Electron 读取保存
        try {
          const has: any = await (window as any).host?.images?.clipboardHasImage?.();
          if (has && has.ok && has.has) {
            e.preventDefault();
            const res: any = await (window as any).host?.images?.saveFromClipboard?.({ projectWinRoot: (rest as any)?.winRoot || winRoot, projectName: (rest as any)?.projectName || projectName });
            if (res && res.ok) {
              const saved: SavedImage = { id: String(Date.now()), blob: new Blob(), previewUrl: '', type: 'image/png', size: 0, saved: true, winPath: res.winPath, wslPath: res.wslPath, fileName: res.fileName, fromPaste: true } as any;
              // 预览排序：新粘贴靠右（追加到末尾，保留最近 6 张）
              setPastedImages((arr) => [...arr, saved].slice(-6));
              const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
              if (el) {
                const ins = (saved.wslPath ? ("`" + saved.wslPath + "`") : "");
                const prefix = (value && !/\s$/.test(value)) ? '\n' : '';
                const suffix = '\n';
                const { next, nextCaret } = insertTextAtCursor(el, value, `${prefix}${ins}${suffix}`);
                onValueChange(next);
                requestAnimationFrame(() => { try { (el as any).setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
              }
            }
            return;
          }
        } catch {}
        return; // 非图片粘贴
      }
      // 有图片：阻止默认，开始保存
      e.preventDefault();
      const saved = await persistImages(imgs, (rest as any)?.winRoot || winRoot, (rest as any)?.projectName || projectName);
      // 预览排序：新粘贴靠右（追加到末尾，保留最近 6 张）
      setPastedImages((arr) => [...arr, ...saved].slice(-6));
      // 将每张图片以“WSL 绝对路径”形式插入文本框（逐张换行）
      const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
      if (!el) return;
      const tokens = saved.map((s) => (s.wslPath ? ("`" + s.wslPath + "`") : '')).join('\n');
      const prefix = (value && !/\s$/.test(value)) ? '\n' : '';
      const insert = `${prefix}${tokens}\n`;
      const { next, nextCaret } = insertTextAtCursor(el, value, insert);
      onValueChange(next);
      requestAnimationFrame(() => { try { (el as any).setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
    } catch {}
  };

  // 点击选中项：替换 @xxxx（整段，包括 @ 一并替换掉）
  const handlePick = (item: AtItem) => {
    const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
    if (!el) return;
    // @ts-ignore
    const caret = (el.selectionStart as number) ?? String(value || "").length;
    const left = value.slice(0, caret);
    const at = left.lastIndexOf("@");
    // WSL 路径插入：文件/目录返回“`WSL 相对路径`”样式（两侧带反引号，/ 分隔）；规则等其它类别按标题插入
    let insertText = item.title;
    try {
      if (item.categoryId === 'files') {
        const relOrPath = String((item as any).path || (item as any).subtitle || item.title || "");
        const isRel = !/^\//.test(relOrPath) && !/^([a-zA-Z]):\\/.test(relOrPath) && !/^\\\\/.test(relOrPath);
        const wsl = (projectPathStyle === 'absolute' && isRel && winRoot)
          ? toWSLForInsert(joinWinAbs(String(winRoot), relOrPath))
          : toWSLForInsert(relOrPath);
        insertText = "`" + wsl + "`";
      }
    } catch {}
    const { next, nextCaret } = replaceAtQuery(value, caret, insertText);
    onValueChange(next);
    requestAnimationFrame(() => {
      try {
        // @ts-ignore
        (el as any).setSelectionRange(nextCaret, nextCaret);
        el.focus();
      } catch {}
    });
    // 关闭并抑制：记录此次使用的 @ 索引
    dismissedAtIndexRef.current = (at >= 0 ? at : (atIndexRef.current ?? null));
    atIndexRef.current = null;
    setQ("");
    setOpen(false);
  };

  // 进入分类：来自一级列表点击
  const handleEnterCategory = (id: AtCategoryId) => {
    setScope(id);
    setLevel("results");
  };

  // 对外暴露 ref：保持与 Input 行为一致
  // 合并外部 onKeyDown
  const externalOnKeyDown = (rest as any)?.onKeyDown as ((e: React.KeyboardEvent<any>) => void) | undefined;

  return (
    <>
      <Input
        ref={ref as any}
        value={value}
        onChange={onLocalChange}
        onKeyDown={(e: any) => { try { externalOnKeyDown && externalOnKeyDown(e); } catch {} onKeyDown(e); }}
        onPaste={onPaste}
        onDragOver={(e) => { try { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } catch {} }}
        onDrop={(e) => {
          try {
            e.preventDefault();
            const list = extractWinPathsFromDataTransfer(e.dataTransfer);
            if (!list || list.length === 0) return;
            const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
            if (!el) return;
            const paths = list.map((wp) => toWslRelOrAbsForProject(wp, (rest as any)?.winRoot || winRoot, projectPathStyle === 'absolute' ? 'absolute' : 'relative'));
            const tokens = paths.map((p) => (p ? ("`" + p + "`") : "")).filter(Boolean).join('\n');
            const prefix = (value && !/\s$/.test(value)) ? '\n' : '';
            const insert = `${prefix}${tokens}\n`;
            const { next, nextCaret } = insertTextAtCursor(el, value, insert);
            onValueChange(next);
            requestAnimationFrame(() => { try { (el as any).setSelectionRange(nextCaret, nextCaret); el.focus(); } catch {} });
          } catch {}
        }}
        {...rest as any}
      />
      {/* 粘贴图片预览区（最多展示最近 6 张，参考 Slack/GitHub 行为） */}
      {pastedImages.length > 0 && (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {pastedImages.map((img) => (
            <div key={img.id} className="group relative border rounded-md bg-white shadow-sm overflow-hidden">
              {/* 小图预览：优先 blob URL；否则使用 file:// Windows 路径 */}
              {img.previewUrl ? (
                <img src={img.previewUrl} className="block h-16 w-16 object-cover" alt={img.fileName || 'image'} />
              ) : (
                <img src={img.winPath ? ('file:///' + String(img.winPath).replace(/\\\\/g, '/')) : ''} className="block h-16 w-16 object-cover" alt={img.fileName || 'image'} />
              )}
              {/* 右键：打开所在文件夹 */}
              <div
                className="absolute inset-0"
                onContextMenu={(ev) => {
                  ev.preventDefault(); ev.stopPropagation();
                  const wp = img.winPath;
                  if (wp) { try { (window as any).host?.utils?.showInFolder?.(wp); } catch {} }
                }}
              />
              {/* Hover 大图 */}
              <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="absolute z-10 left-full top-0 ml-2 p-1 bg-white border rounded shadow-lg">
                  <img
                    src={img.previewUrl || (img.winPath ? ('file:///' + String(img.winPath).replace(/\\\\/g, '/')) : '')}
                    className="block max-h-56 max-w-56 object-contain"
                    alt={img.fileName || 'image'}
                  />
                </div>
              </div>
              {/* 删除按钮（删除图片预览并删除正文中所有对应路径令牌） */}
              <button
                type="button"
                title="删除图片与关联文字"
                className="absolute right-0 top-0 m-0.5 hidden h-5 w-5 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                onClick={async (ev) => {
                  ev.preventDefault(); ev.stopPropagation();
                  const pathToken = String(img.wslPath || '');
                  if (!pathToken) { setPastedImages((arr) => arr.filter((x) => x.id !== img.id)); return; }
                  try {
                    // 若为本次粘贴生成的文件，优先彻底删除
                    if (img.fromPaste && img.winPath) {
                      try { await (window as any).host?.images?.trash?.({ winPath: img.winPath }); } catch {}
                    }
                    const el = ref.current as HTMLTextAreaElement | HTMLInputElement | null;
                    if (!el) { setPastedImages((arr) => arr.filter((x) => x.id !== img.id)); return; }
                    // 优先删除反引号包裹形式，其次删除裸路径（兼容旧记录）
                    const wrapped = "`" + pathToken + "`";
                    let cur = value;
                    const r1 = removeToken(cur, wrapped, false);
                    cur = r1.next;
                    const r2 = removeToken(cur, pathToken, false);
                    cur = r2.next.replace(/``/g, ""); // 清理潜在空反引号
                    onValueChange(cur);
                  } finally {
                    // value 更新后，useEffect 将自动移除该图片预览
                  }
                }}
              >
                ×
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-white px-1 py-0.5 truncate" title={img.wslPath || img.winPath || ''}>
                {img.fileName || 'image'}
              </div>
            </div>
          ))}
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

export default AtInput;
