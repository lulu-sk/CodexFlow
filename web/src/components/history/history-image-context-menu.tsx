// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy as CopyIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export type HistoryImageContextMenuPayload = {
  src?: string;
  fallbackSrc?: string;
  localPath?: string;
};

type HistoryImageContextMenuState = {
  show: boolean;
  x: number;
  y: number;
};

type HistoryImageContextMenuResult = {
  openContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  contextMenuNode: React.ReactNode;
};

const HISTORY_IMAGE_CONTEXT_MENU_MARGIN = 8;
const HISTORY_IMAGE_CONTEXT_MENU_WIDTH = 188;
const HISTORY_IMAGE_CONTEXT_MENU_HEIGHT = 96;

/**
 * 中文说明：将历史图片右键菜单位置限制在视口内，避免菜单贴边被裁切。
 */
function clampHistoryImageContextMenuPosition(event: React.MouseEvent<HTMLElement>): { x: number; y: number } {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
  const nextX = viewportWidth > 0
    ? Math.min(
        Math.max(event.clientX, HISTORY_IMAGE_CONTEXT_MENU_MARGIN),
        Math.max(HISTORY_IMAGE_CONTEXT_MENU_MARGIN, viewportWidth - HISTORY_IMAGE_CONTEXT_MENU_WIDTH),
      )
    : event.clientX;
  const nextY = viewportHeight > 0
    ? Math.min(
        Math.max(event.clientY, HISTORY_IMAGE_CONTEXT_MENU_MARGIN),
        Math.max(HISTORY_IMAGE_CONTEXT_MENU_MARGIN, viewportHeight - HISTORY_IMAGE_CONTEXT_MENU_HEIGHT),
      )
    : event.clientY;
  return { x: nextX, y: nextY };
}

/**
 * 中文说明：复制历史图片到系统剪贴板，优先复用主进程暴露的原生图片能力。
 */
async function copyHistoryImageToClipboard(args: HistoryImageContextMenuPayload): Promise<void> {
  const hostImages = window.host?.images;
  if (!hostImages?.copyToClipboard) return;
  await hostImages.copyToClipboard({
    localPath: String(args.localPath || "").trim(),
    src: String(args.src || "").trim(),
    fallbackSrc: String(args.fallbackSrc || "").trim(),
  });
}

/**
 * 中文说明：复制历史图片的本地路径文本，便于继续排查或复用原文件。
 */
async function copyHistoryImagePathToClipboard(localPath?: string): Promise<void> {
  const normalizedPath = String(localPath || "").trim();
  if (!normalizedPath) return;

  try {
    const copyText = window.host?.utils?.copyText;
    if (copyText) {
      await copyText(normalizedPath);
      return;
    }
  } catch {}

  try {
    await navigator.clipboard.writeText(normalizedPath);
  } catch {}
}

/**
 * 中文说明：为历史详情中的图片缩略图提供统一右键菜单能力，复用在独立图片块与行内缩略图。
 */
export function useHistoryImageContextMenu(payload: HistoryImageContextMenuPayload): HistoryImageContextMenuResult {
  const { t } = useTranslation(["history"]);
  const primarySrc = String(payload.src || "").trim();
  const fallbackSrc = String(payload.fallbackSrc || "").trim();
  const localPath = String(payload.localPath || "").trim();
  const [menuState, setMenuState] = useState<HistoryImageContextMenuState>({ show: false, x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);

  /**
   * 中文说明：关闭历史图片右键菜单，避免滚动、外部点击后残留浮层。
   */
  const closeContextMenu = useCallback(() => {
    setMenuState((previous) => (previous.show ? { ...previous, show: false } : previous));
  }, []);

  /**
   * 中文说明：按鼠标位置打开历史图片右键菜单，并限制菜单不会溢出视口。
   */
  const openContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextPosition = clampHistoryImageContextMenuPosition(event);
    setMenuState({ show: true, ...nextPosition });
  }, []);

  /**
   * 中文说明：执行“复制图片”菜单动作，统一复用主进程剪贴板桥接。
   */
  const handleCopyImage = useCallback(async () => {
    try {
      await copyHistoryImageToClipboard({ localPath, src: primarySrc, fallbackSrc });
    } catch {}
    closeContextMenu();
  }, [closeContextMenu, fallbackSrc, localPath, primarySrc]);

  /**
   * 中文说明：执行“复制路径”菜单动作，仅在存在本地路径时启用。
   */
  const handleCopyPath = useCallback(async () => {
    await copyHistoryImagePathToClipboard(localPath);
    closeContextMenu();
  }, [closeContextMenu, localPath]);

  useEffect(() => {
    if (!menuState.show) return;

    /**
     * 中文说明：点击菜单外部区域时关闭右键菜单，避免悬浮菜单滞留。
     */
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      closeContextMenu();
    };

    /**
     * 中文说明：按下 Escape 时关闭右键菜单，补齐键盘退出路径。
     */
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeContextMenu, menuState.show]);

  const contextMenuNode = menuState.show && typeof document !== "undefined"
    ? createPortal(
        <div
          className="fixed z-[1300]"
          style={{ left: Math.round(menuState.x), top: Math.round(menuState.y) }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            ref={menuRef}
            className="min-w-[168px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1.5 shadow-apple-lg backdrop-blur-apple dark:shadow-apple-dark-lg"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-apple-sm px-3 py-1.5 text-left text-sm text-[var(--cf-text-primary)] transition-all duration-apple-fast hover:bg-[var(--cf-surface-hover)] disabled:opacity-40"
              onClick={handleCopyImage}
              disabled={!primarySrc && !fallbackSrc && !localPath}
            >
              <CopyIcon className="h-4 w-4 text-[var(--cf-text-muted)]" />
              <span>{t("history:copyImage")}</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-apple-sm px-3 py-1.5 text-left text-sm text-[var(--cf-text-primary)] transition-all duration-apple-fast hover:bg-[var(--cf-surface-hover)] disabled:opacity-40"
              onClick={handleCopyPath}
              disabled={!localPath}
            >
              <CopyIcon className="h-4 w-4 text-[var(--cf-text-muted)]" />
              <span>{t("history:copyPath")}</span>
            </button>
          </div>
        </div>,
        document.body,
      )
    : null;

  return {
    openContextMenu,
    contextMenuNode,
  };
}
