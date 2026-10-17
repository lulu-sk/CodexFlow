// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Eye, FolderOpen, Redo2, RotateCcw, SquareArrowOutUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatHistoryDiffPath } from "./turn-diff";
import { resolveHistoryDiffFilePath } from "./turn-diff-file-actions";

type HistoryDiffFileMenuOptions = {
  projectWinPath?: string;
  pathBase?: string;
  canPatch: boolean;
  isReverted: (path: string) => boolean;
  onReview: (path: string) => void;
  onPatch: (path: string) => void | Promise<void>;
  onError: (message: string) => void;
};

/** 为卡片、文件列表和审核标题提供同一套按文件操作，并管理键盘和浮层关闭行为。 */
export function useHistoryDiffFileMenu(options: HistoryDiffFileMenuOptions) {
  const { t } = useTranslation("history");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /** 关闭文件菜单并恢复触发位置的键盘焦点。 */
  const closeMenu = (): void => {
    setMenu(null);
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
  };

  /** 从右键或操作按钮打开菜单，并把位置限制在视口内。 */
  const openFileMenu = (path: string, event: MouseEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    returnFocusRef.current = event.currentTarget;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.type === "contextmenu" ? event.clientX : bounds.right;
    const y = event.type === "contextmenu" ? event.clientY : bounds.bottom;
    setMenu({ path, x: Math.max(8, Math.min(x, window.innerWidth - 236)), y: Math.max(8, Math.min(y, window.innerHeight - 250)) });
  };

  /** 统一执行文件操作并显示失败原因，避免菜单动作静默失败。 */
  const runAction = async (action: () => void | Promise<void>): Promise<void> => {
    closeMenu();
    try {
      await action();
    } catch (error) {
      options.onError(String((error as Error)?.message || error || t("history:turnDiffFileActionFailed")));
    }
  };

  /** 复制文件路径，优先使用主进程剪贴板能力。 */
  const copyPath = async (path: string): Promise<void> => {
    if (window.host?.utils?.copyText) {
      const result = await window.host.utils.copyText(path);
      if (!result.ok) throw new Error(result.error || String(t("history:turnDiffFileActionFailed")));
      return;
    }
    await navigator.clipboard.writeText(path);
  };

  useEffect(() => {
    if (!menu) return;
    const menuRoot = menuRef.current;
    menuRoot?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });

    /** 点击外部位置时关闭菜单，保留用户原本要点击的控件。 */
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (menuRoot?.contains(event.target as Node)) return;
      setMenu(null);
    };
    /** 处理菜单方向键和退出键，避免审核弹窗同时响应这些按键。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeMenu();
        } else setMenu(null);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const buttons = Array.from(menuRoot?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    };
    /** 视口变化后关闭菜单，防止菜单与原文件位置脱离。 */
    const handleViewportChange = (): void => setMenu(null);
    window.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [menu]);

  const filePath = menu ? resolveHistoryDiffFilePath(menu.path, options.pathBase) : "";
  const relativePath = menu ? formatHistoryDiffPath(menu.path.split(" -> ").pop() || "", options.pathBase) : "";
  const canCopy = !!window.host?.utils?.copyText || !!navigator.clipboard?.writeText;
  const reverted = menu ? options.isReverted(menu.path) : false;
  const itemClassName = "flex w-full items-center gap-2 rounded-apple-sm px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--cf-surface-hover)] focus-visible:bg-[var(--cf-surface-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";
  const menuNode = menu ? createPortal(
    <div ref={menuRef} role="menu" aria-label={String(t("history:turnDiffFileMenu"))}
      className="fixed z-[10000] w-56 rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-1.5 text-[var(--cf-text-primary)] shadow-apple-lg"
      style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" className={itemClassName} onClick={() => { void runAction(() => options.onReview(menu.path)); }}>
        <Eye className="h-4 w-4" />{t("history:turnDiffReview")}
      </button>
      <button type="button" role="menuitem" className={itemClassName} disabled={!filePath || (!window.host?.utils?.openPathAtPosition && !window.host?.utils?.openPath)} onClick={() => { void runAction(async () => {
        const result = window.host?.utils?.openPathAtPosition
          ? await window.host.utils.openPathAtPosition(filePath, { projectPath: options.projectWinPath, line: 1 })
          : await window.host.utils.openPath(filePath);
        if (!result.ok) throw new Error(result.error || String(t("history:turnDiffFileActionFailed")));
      }); }}>
        <SquareArrowOutUpRight className="h-4 w-4" />{t("history:turnDiffOpenFile")}
      </button>
      <button type="button" role="menuitem" className={itemClassName} disabled={!filePath || !window.host?.utils?.showInFolder} onClick={() => { void runAction(async () => {
        const result = await window.host.utils.showInFolder(filePath);
        if (!result.ok) throw new Error(result.error || String(t("history:turnDiffFileActionFailed")));
      }); }}>
        <FolderOpen className="h-4 w-4" />{t("history:turnDiffShowInFolder")}
      </button>
      <button type="button" role="menuitem" className={itemClassName} disabled={!filePath || !canCopy} onClick={() => { void runAction(() => copyPath(filePath)); }}>
        <Copy className="h-4 w-4" />{t("history:copyPath")}
      </button>
      <button type="button" role="menuitem" className={itemClassName} disabled={!relativePath || !canCopy} onClick={() => { void runAction(() => copyPath(relativePath)); }}>
        <Copy className="h-4 w-4" />{t("history:turnDiffCopyRelativePath")}
      </button>
      <div role="separator" className="my-1 h-px bg-[var(--cf-border)]" />
      <button type="button" role="menuitem" className={itemClassName} disabled={!options.canPatch} onClick={() => { void runAction(() => options.onPatch(menu.path)); }}>
        {reverted ? <Redo2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
        {t(reverted ? "history:turnDiffReapplyFile" : "history:turnDiffUndoFile")}
      </button>
    </div>, document.body,
  ) : null;

  return { openFileMenu, menuNode };
}
